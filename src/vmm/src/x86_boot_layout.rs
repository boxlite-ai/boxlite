// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Pure x86_64 boot layout calculations, independent of linux-loader, KVM,
//! and guest memory allocation. The Linux x86_64 `boot` module and this
//! crate's tests share them. Boot page-table planning also belongs here.

use std::{io, ops::Range};

use vm_memory::GuestAddress;

/// Usable low RAM ends where the MP table and the legacy BIOS areas begin.
pub(crate) const LOW_RAM_END: u64 = 0x9_fc00;
/// Usable RAM resumes here, above the legacy BIOS areas.
pub(crate) const HIGH_RAM_START: u64 = 0x10_0000;
/// Start of the 23-page fast window, just above the boot stack.
pub(crate) const TABLES_BASE: u64 = 0x9000;
/// Exclusive end of the fast window, where the command line starts.
pub(crate) const TABLES_FAST_END: u64 = 0x2_0000;
const PAGE_SIZE: u64 = 0x1000;
const MIB_PAGE: u64 = 1 << 21;
const GIB_PAGE: u64 = 1 << 30;
const PDPT_SPAN: u64 = 1 << 39;
/// Four-level identity paging can only use lower-half canonical addresses.
pub(crate) const IDENTITY_END: u64 = 1 << 47;
const TABLE_SPANS: [u64; 4] = [512 * PDPT_SPAN, PDPT_SPAN, GIB_PAGE, MIB_PAGE];
const MAX_TABLE_PAGES: u64 = 1 << 18;
const PRESENT_WRITABLE: u64 = 0b11;
const LARGE_PAGE: u64 = 1 << 7;

/// Largest allowed leaf. Partial blocks fall back to smaller leaves.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum PageSize {
    Gib,
    #[default]
    Mib,
    #[allow(dead_code, reason = "This internal boot leaf may not be selected.")]
    Kib,
}

/// Boot leaf size checked against the guest's CPU features.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CheckedBootLeaf(PageSize);

impl PageSize {
    pub(crate) fn checked(self, pdpe1gb: bool) -> io::Result<CheckedBootLeaf> {
        if self == Self::Gib && !pdpe1gb {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "1 GiB boot pages require CPUID pdpe1gb",
            ));
        }
        Ok(CheckedBootLeaf(self))
    }
}

impl CheckedBootLeaf {
    pub(crate) fn page_size(self) -> PageSize {
        self.0
    }
}

pub(crate) struct TablePage {
    pub addr: u64,
    pub entries: [u64; 512],
}

pub(crate) struct TablePlan {
    pub pml4: u64,
    pub pages: Vec<TablePage>,
}

impl TablePlan {
    /// The half-open interval occupied by the table pages, not the entire window.
    pub(crate) fn tables(&self) -> (u64, u64) {
        (self.pml4, self.pml4 + self.pages.len() as u64 * PAGE_SIZE)
    }

    /// E820 intervals the guest must not reuse, keyed by where the tables sit.
    ///
    /// Tables in the fixed boot area stay out of the map, as Firecracker does:
    /// every byte of that low memory is conventionally usable RAM, and the
    /// kernel rebuilds CR3 in `__startup_64` before it allocates anything, so
    /// the tables it leaves behind are dead by then. Tables placed above the
    /// kernel are new low-band memory the kernel would hand out later, so they
    /// are reported reserved instead.
    pub(crate) fn reserved(&self, fast: bool) -> Vec<(u64, u64)> {
        if fast {
            Vec::new()
        } else {
            vec![self.tables()]
        }
    }
}

/// Plans the boot identity map in the fixed boot area if the occupied pages
/// fit without overlapping the kernel or initramfs. The fast tables can be
/// above or below the kernel; the slow window is always above it.
/// `kernel` is the half-open physical interval bounding all loadable segments.
pub(crate) fn plan_boot_tables(
    ranges: &[(GuestAddress, usize)],
    kernel: (u64, u64),
    initramfs: Option<(GuestAddress, usize)>,
    leaf: PageSize,
) -> io::Result<TablePlan> {
    let needed = table_pages(ranges, leaf)?;
    let fast_tables = (TABLES_BASE, TABLES_BASE + needed * PAGE_SIZE);
    let disjoint = |a: (u64, u64), b: (u64, u64)| a.1 <= b.0 || a.0 >= b.1;
    if fast_tables.1 <= TABLES_FAST_END
        && disjoint(fast_tables, kernel)
        && initramfs
            .is_none_or(|(start, len)| disjoint(fast_tables, (start.0, start.0 + len as u64)))
    {
        return plan(ranges, (TABLES_BASE, TABLES_FAST_END), leaf);
    }
    // The slow window ends no later than the initramfs start, if present.
    let end = initramfs.map_or(low_ram_end(ranges)?, |(start, _)| start.0);
    // Aligning up keeps the slow window start at or above the kernel end.
    let start = kernel
        .1
        .max(HIGH_RAM_START)
        .checked_next_multiple_of(PAGE_SIZE)
        .filter(|&start| start < end)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "no room above the kernel for boot page tables",
            )
        })?;
    plan(ranges, (start, end), leaf)
}

/// Number of 4 KiB table pages an identity map of `ranges` needs at `leaf`.
pub(crate) fn table_pages(ranges: &[(GuestAddress, usize)], leaf: PageSize) -> io::Result<u64> {
    Ok(table_layout(ranges, leaf)?.needed)
}

struct TableLayout {
    ram: Vec<Range<u64>>,
    first_leaf: usize,
    blocks: [Vec<Range<u64>>; 4],
    counts: [u64; 4],
    needed: u64,
}

// Shared by sizing and planning so the writer can reuse the counted runs.
fn table_layout(ranges: &[(GuestAddress, usize)], leaf: PageSize) -> io::Result<TableLayout> {
    let invalid = |message| io::Error::new(io::ErrorKind::InvalidInput, message);
    let mut sorted = Vec::new();
    for &(start, len) in ranges {
        let start = start.0;
        let end = start
            .checked_add(len as u64)
            .filter(|&end| end <= IDENTITY_END)
            .ok_or_else(|| invalid("RAM is outside four-level identity address space"))?;
        if !start.is_multiple_of(PAGE_SIZE) || !end.is_multiple_of(PAGE_SIZE) {
            return Err(invalid("boot page tables require page-aligned RAM"));
        }
        if start < end {
            sorted.push(start..end);
        }
    }
    sorted.sort_unstable_by_key(|range| range.start);
    let mut ram = Vec::new();
    for range in sorted {
        push_span(&mut ram, range);
    }

    let first_leaf = match leaf {
        PageSize::Gib => 1,
        PageSize::Mib => 2,
        PageSize::Kib => 3,
    };
    // Run-length encoded table indices, grouped by level. A fully covered
    // block needs no child table if its parent can map it with a large leaf.
    let mut blocks = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    blocks[0].push(0..1);
    for level in 1..blocks.len() {
        let span = TABLE_SPANS[level];
        for range in &ram {
            if level <= first_leaf {
                push_span(
                    &mut blocks[level],
                    range.start / span..range.end.div_ceil(span),
                );
            } else {
                if !range.start.is_multiple_of(span) {
                    let block = range.start / span;
                    push_span(&mut blocks[level], block..block + 1);
                }
                if !range.end.is_multiple_of(span) {
                    let block = range.end / span;
                    push_span(&mut blocks[level], block..block + 1);
                }
            }
        }
    }
    let counts = blocks
        .each_ref()
        .map(|runs| runs.iter().map(|r| r.end - r.start).sum::<u64>());
    let needed = counts.iter().sum();
    Ok(TableLayout {
        ram,
        first_leaf,
        blocks,
        counts,
        needed,
    })
}

/// Plan four-level identity mappings for page-aligned RAM, leaving holes absent.
/// The half-open `window` supplies contiguous storage for the table pages.
pub(crate) fn plan(
    ranges: &[(GuestAddress, usize)],
    window: (u64, u64),
    leaf: PageSize,
) -> io::Result<TablePlan> {
    let invalid = |message| io::Error::new(io::ErrorKind::InvalidInput, message);
    let (base, end) = window;
    if !base.is_multiple_of(PAGE_SIZE) || end < base {
        return Err(invalid("invalid boot page-table window"));
    }
    let TableLayout {
        ram,
        first_leaf,
        blocks,
        counts,
        needed,
    } = table_layout(ranges, leaf)?;
    let available = ((end - base) / PAGE_SIZE).min(MAX_TABLE_PAGES);
    if needed > available {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("boot page tables need {needed} pages, but only {available} are available"),
        ));
    }
    // Entry bits 51:12 hold the table address. Only the used part of the
    // window must fit there; the capacity check also makes addition safe.
    if base + needed * PAGE_SIZE > 1 << 52 {
        return Err(invalid("boot page tables exceed the entry address field"));
    }

    // Assign every table a GPA before writing links or leaves. Within a
    // level, ascending block numbers also give ascending page addresses.
    let mut pages: Vec<_> = (0..needed)
        .map(|index| TablePage {
            addr: base + index * PAGE_SIZE,
            entries: [0; 512],
        })
        .collect();
    let mut offset = 0;
    for level in 0..blocks.len() {
        let span = TABLE_SPANS[level];
        let entry_span = span / 512;
        let next_offset = offset + counts[level] as usize;
        let (current, rest) = pages.split_at_mut(next_offset);
        let mut children = blocks
            .get(level + 1)
            .into_iter()
            .flat_map(|runs| table_indices(runs))
            .zip(rest.iter())
            .peekable();
        for (block, page) in table_indices(&blocks[level]).zip(&mut current[offset..]) {
            let start = block * span;
            let end = start + span;
            while children
                .peek()
                .is_some_and(|(block, _)| block * entry_span < end)
            {
                let (child_block, child) = children.next().unwrap();
                page.entries[(child_block % 512) as usize] = child.addr | PRESENT_WRITABLE;
            }
            if level >= first_leaf {
                let flags = PRESENT_WRITABLE | if level < 3 { LARGE_PAGE } else { 0 };
                let first = ram.partition_point(|range| range.end <= start);
                for range in ram[first..].iter().take_while(|range| range.start < end) {
                    let from = range.start.max(start).div_ceil(entry_span);
                    let to = range.end.min(end) / entry_span;
                    for index in from..to {
                        page.entries[(index % 512) as usize] = (index * entry_span) | flags;
                    }
                }
            }
        }
        offset = next_offset;
    }
    Ok(TablePlan { pml4: base, pages })
}

/// Append a sorted interval, coalescing overlap and adjacency.
fn push_span(spans: &mut Vec<Range<u64>>, span: Range<u64>) {
    if let Some(last) = spans.last_mut()
        && span.start <= last.end
    {
        last.end = last.end.max(span.end);
    } else {
        spans.push(span);
    }
}

fn table_indices(runs: &[Range<u64>]) -> impl Iterator<Item = u64> + '_ {
    runs.iter().flat_map(Clone::clone)
}

/// Usable RAM intervals for `ranges`, without `[LOW_RAM_END, HIGH_RAM_START)`.
pub(crate) fn e820_ram_ranges(ranges: &[(GuestAddress, usize)]) -> Vec<(u64, u64)> {
    let mut usable = Vec::new();
    for &(start, size) in ranges {
        let (start, end) = (start.0, start.0 + size as u64);
        for (from, to) in [
            (start, end.min(LOW_RAM_END)),
            (start.max(HIGH_RAM_START), end),
        ] {
            if from < to {
                usable.push((from, to - from));
            }
        }
    }
    usable
}

/// End of the nonempty RAM range that holds GPA 0.
pub(crate) fn low_ram_end(ranges: &[(GuestAddress, usize)]) -> io::Result<u64> {
    ranges
        .iter()
        .find_map(|&(start, len)| (start.0 == 0 && len != 0).then_some(len as u64))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "no RAM range at guest address 0",
            )
        })
}

/// The top page-aligned slot of the RAM range that holds guest address 0.
/// Linux warns about an unaligned initramfs start when freeing its pages.
pub(crate) fn initramfs_slot(
    ranges: &[(GuestAddress, usize)],
    size: usize,
) -> io::Result<GuestAddress> {
    if size == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the initramfs is empty",
        ));
    }
    let len = low_ram_end(ranges)?;
    let start = len.checked_sub(size as u64).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("an initramfs of {size} bytes does not fit in {len:#x} bytes of RAM"),
        )
    })?;
    Ok(GuestAddress(start & !(PAGE_SIZE - 1)))
}

#[cfg(test)]
#[path = "../tests/x86_boot_layout/mod.rs"]
mod tests;
