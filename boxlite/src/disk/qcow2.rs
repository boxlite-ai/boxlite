//! Qcow2 disk image management.
//!
//! Creates and manages qcow2 disk images for Box block devices.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use qcow2_rs::meta::Qcow2Header;

use super::constants::qcow2::{BLOCK_SIZE, CLUSTER_BITS, DEFAULT_DISK_SIZE_GB, REFCOUNT_ORDER};
use super::{Disk, DiskFormat};

/// Parsed qcow2 header information.
#[allow(dead_code)]
#[derive(Debug)]
struct Qcow2HeaderInfo {
    #[allow(dead_code)]
    version: u32,
    size: u64,
    #[allow(dead_code)]
    cluster_bits: u32,
}

/// Helper for qcow2 disk operations.
pub struct Qcow2Helper;

impl Qcow2Helper {
    /// Create a qcow2 disk image at the specified path (uses native Rust implementation).
    ///
    /// The disk is sparse (10GB virtual size, ~200KB actual until written).
    /// Returns a RAII-managed Disk that auto-cleans up on drop (unless persistent).
    ///
    /// # Arguments
    /// * `disk_path` - Path where the disk should be created
    /// * `persistent` - If true, disk won't be deleted on drop (used for base disks)
    #[allow(dead_code)]
    pub fn create_disk(disk_path: &Path, persistent: bool) -> BoxliteResult<Disk> {
        // Ensure parent directory exists
        if let Some(parent) = disk_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create parent directory {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }

        if disk_path.exists() {
            tracing::debug!("Disk already exists: {}", disk_path.display());
            return Ok(Disk::new(
                disk_path.to_path_buf(),
                DiskFormat::Qcow2,
                persistent,
            ));
        }

        tracing::info!(
            "Creating qcow2 disk: {} ({}GB sparse)",
            disk_path.display(),
            DEFAULT_DISK_SIZE_GB
        );

        let size_bytes = DEFAULT_DISK_SIZE_GB * 1024 * 1024 * 1024;

        // Calculate required metadata size
        let (rc_table, rc_block, _l1_table) = Qcow2Header::calculate_meta_params(
            size_bytes,
            CLUSTER_BITS,
            REFCOUNT_ORDER,
            BLOCK_SIZE,
        );
        let clusters = 1 + rc_table.1 + rc_block.1;
        let buffer_size = ((clusters as usize) << CLUSTER_BITS) + BLOCK_SIZE;

        let mut header_buf = vec![0u8; buffer_size];
        Qcow2Header::format_qcow2(
            &mut header_buf,
            size_bytes,
            CLUSTER_BITS,
            REFCOUNT_ORDER,
            BLOCK_SIZE,
        )
        .map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to format qcow2 header for disk {}: {}",
                disk_path.display(),
                e
            ))
        })?;

        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(disk_path)
            .map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create disk file {}: {}",
                    disk_path.display(),
                    e
                ))
            })?;

        file.write_all(&header_buf).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to write qcow2 header to disk {}: {}",
                disk_path.display(),
                e
            ))
        })?;

        tracing::info!("Created qcow2 disk: {}", disk_path.display());
        Ok(Disk::new(
            disk_path.to_path_buf(),
            DiskFormat::Qcow2,
            persistent,
        ))
    }

    /// Create a qcow2 disk image using external qemu-img binary.
    #[allow(dead_code)]
    fn create_disk_external(disk_path: &Path, persistent: bool) -> BoxliteResult<Disk> {
        // Ensure parent directory exists
        if let Some(parent) = disk_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create parent directory {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }

        if disk_path.exists() {
            tracing::debug!("Disk already exists: {}", disk_path.display());
            return Ok(Disk::new(
                disk_path.to_path_buf(),
                DiskFormat::Qcow2,
                persistent,
            ));
        }

        tracing::info!(
            "Creating qcow2 disk: {} ({}GB sparse)",
            disk_path.display(),
            DEFAULT_DISK_SIZE_GB
        );

        let output = Command::new("qemu-img")
            .args(["create", "-f", "qcow2"])
            .arg(disk_path)
            .arg(format!("{}G", DEFAULT_DISK_SIZE_GB))
            .output()
            .map_err(|e| BoxliteError::Storage(format!("Failed to run qemu-img: {}", e)))?;

        if !output.status.success() {
            return Err(BoxliteError::Storage(format!(
                "Failed to create qcow2 disk {}: {}",
                disk_path.display(),
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        tracing::info!("Created qcow2 disk: {}", disk_path.display());
        Ok(Disk::new(
            disk_path.to_path_buf(),
            DiskFormat::Qcow2,
            persistent,
        ))
    }

    /// Create COW child disk from base disk.
    ///
    /// PERF: Uses native Rust implementation instead of qemu-img subprocess.
    /// This reduces COW disk creation from ~28ms (subprocess) to ~1ms (native).
    ///
    /// This creates a qcow2 disk that uses the base disk as a backing file.
    /// Reads come from the base (shared), writes go to the child (per-box).
    ///
    /// # Arguments
    /// * `base_disk` - Path to base disk (read-only, shared)
    /// * `backing_format` - Format of the backing file (Raw or Qcow2)
    /// * `child_path` - Path where the child disk should be created
    /// * `virtual_size` - Virtual size of the disk in bytes
    ///
    /// # Returns
    /// RAII-managed Disk (auto-cleanup on drop)
    pub fn create_cow_child_disk(
        base_disk: &Path,
        backing_format: BackingFormat,
        child_path: &Path,
        virtual_size: u64,
    ) -> BoxliteResult<Disk> {
        // Ensure parent directory exists
        if let Some(parent) = child_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create parent directory {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }

        if child_path.exists() {
            tracing::debug!("Child disk already exists: {}", child_path.display());
            return Ok(Disk::new(
                child_path.to_path_buf(),
                DiskFormat::Qcow2,
                false,
            ));
        }

        tracing::info!(
            "Creating COW child disk: {} (backing: {}, format: {})",
            child_path.display(),
            base_disk.display(),
            backing_format.as_str()
        );

        // Create COW child with backing file reference
        Self::write_cow_child_header(child_path, base_disk, backing_format, virtual_size)?;

        tracing::info!("Created COW child disk: {}", child_path.display());
        // COW children are per-box, should be cleaned up
        Ok(Disk::new(
            child_path.to_path_buf(),
            DiskFormat::Qcow2,
            false,
        ))
    }

    /// Get the virtual size of a qcow2 disk image.
    #[allow(dead_code)]
    pub fn qcow2_virtual_size(path: &Path) -> BoxliteResult<u64> {
        let header = Self::read_qcow2_header(path)?;
        Ok(header.size)
    }

    /// Flatten a QCOW2 backing chain into a standalone QCOW2 file.
    ///
    /// Reads `src` and its entire backing chain, merging all COW layers into
    /// a single standalone QCOW2 at `dst` with no backing file reference.
    /// Only non-zero clusters are written (sparse output).
    ///
    /// Equivalent to: `qemu-img convert -O qcow2 <src> <dst>`
    ///
    /// Errors on compressed clusters (bit 62 in L2 entries).
    pub fn flatten(src: &Path, dst: &Path) -> BoxliteResult<()> {
        use std::io::{Seek, SeekFrom, Write};

        tracing::info!(
            src = %src.display(),
            dst = %dst.display(),
            "Flattening QCOW2 disk image"
        );

        // Open the full backing chain (top layer first, base last).
        let mut chain = Self::open_flatten_chain(src)?;

        let (virtual_size, cluster_bits) = match &chain[0] {
            FlattenLayer::Qcow2 {
                virtual_size,
                cluster_bits,
                ..
            } => (*virtual_size, *cluster_bits),
            FlattenLayer::Raw { .. } => {
                return Err(BoxliteError::Storage(
                    "flatten: source file is not QCOW2".into(),
                ));
            }
        };

        let cluster_size = 1u64 << cluster_bits;
        let num_virtual_clusters = virtual_size.div_ceil(cluster_size);
        let l2_entries = cluster_size / 8;
        let num_l1 = num_virtual_clusters.div_ceil(l2_entries) as u32;
        let l1_clusters = ((num_l1 as u64) * 8).div_ceil(cluster_size);

        // Output layout:
        //   Cluster 0:                             Header
        //   Clusters 1..1+l1_clusters:             L1 table
        //   Clusters l2_start..l2_start+num_l1:    L2 tables (pre-allocated slots)
        //   Clusters data_start..:                 Data clusters
        //   After data:                            Refcount table + blocks
        let l2_start = 1 + l1_clusters;
        let data_start = l2_start + num_l1 as u64;

        let mut output = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(dst)
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to create {}: {}", dst.display(), e))
            })?;

        // Phase 1: Write data clusters, building L2 tables in memory.
        let mut l2_tables: Vec<Vec<u64>> = vec![vec![0u64; l2_entries as usize]; num_l1 as usize];
        let mut next_data_cluster = data_start;
        let zero_cluster = vec![0u8; cluster_size as usize];

        for vc in 0..num_virtual_clusters {
            // Resolve cluster through the chain (top-to-bottom).
            let mut data = None;
            for layer in chain.iter_mut() {
                if let Some(d) = layer.read_cluster(vc, cluster_size)? {
                    data = Some(d);
                    break;
                }
            }

            if let Some(ref d) = data
                && d.as_slice() != zero_cluster.as_slice()
            {
                let offset = next_data_cluster * cluster_size;
                output
                    .seek(SeekFrom::Start(offset))
                    .map_err(|e| BoxliteError::Storage(format!("flatten: data seek: {}", e)))?;
                output
                    .write_all(d)
                    .map_err(|e| BoxliteError::Storage(format!("flatten: data write: {}", e)))?;

                let l1_idx = (vc / l2_entries) as usize;
                let l2_idx = (vc % l2_entries) as usize;
                l2_tables[l1_idx][l2_idx] = offset;
                next_data_cluster += 1;
            }
        }

        // Phase 2: Calculate refcount layout.
        let rc_entries_per_block = cluster_size / 2; // 16-bit refcounts
        let rc_table_cluster = next_data_cluster;
        let rc_block_start = rc_table_cluster + 1;
        // Iterate to handle the circular dependency (rc structures count themselves).
        let mut total_clusters = rc_block_start;
        loop {
            let blocks_needed = total_clusters.div_ceil(rc_entries_per_block);
            let new_total = rc_block_start + blocks_needed;
            if new_total <= total_clusters {
                break;
            }
            total_clusters = new_total;
        }
        let num_rc_blocks = total_clusters - rc_block_start;
        let rc_table_offset = rc_table_cluster * cluster_size;

        // Phase 3: Write L1 table.
        output
            .seek(SeekFrom::Start(cluster_size))
            .map_err(|e| BoxliteError::Storage(format!("flatten: L1 seek: {}", e)))?;
        for (i, l2) in l2_tables.iter().enumerate() {
            let has_data = l2.iter().any(|&e| e != 0);
            let entry: u64 = if has_data {
                (l2_start + i as u64) * cluster_size
            } else {
                0
            };
            output
                .write_all(&entry.to_be_bytes())
                .map_err(|e| BoxliteError::Storage(format!("flatten: L1 write: {}", e)))?;
        }

        // Phase 4: Write L2 tables (only those with data).
        for (i, l2) in l2_tables.iter().enumerate() {
            if l2.iter().all(|&e| e == 0) {
                continue;
            }
            let offset = (l2_start + i as u64) * cluster_size;
            output
                .seek(SeekFrom::Start(offset))
                .map_err(|e| BoxliteError::Storage(format!("flatten: L2 seek: {}", e)))?;
            for entry in l2 {
                output
                    .write_all(&entry.to_be_bytes())
                    .map_err(|e| BoxliteError::Storage(format!("flatten: L2 write: {}", e)))?;
            }
        }

        // Phase 5: Write refcount table.
        output
            .seek(SeekFrom::Start(rc_table_offset))
            .map_err(|e| BoxliteError::Storage(format!("flatten: rc table seek: {}", e)))?;
        for i in 0..num_rc_blocks {
            let block_offset = (rc_block_start + i) * cluster_size;
            output
                .write_all(&block_offset.to_be_bytes())
                .map_err(|e| BoxliteError::Storage(format!("flatten: rc table write: {}", e)))?;
        }

        // Phase 6: Write refcount blocks.
        // Mark used clusters: header, L1, referenced L2 tables, data, rc table, rc blocks.
        let mut used = vec![false; total_clusters as usize];
        used[0] = true; // header
        for c in 1..1 + l1_clusters {
            used[c as usize] = true; // L1
        }
        for (i, l2) in l2_tables.iter().enumerate() {
            if l2.iter().any(|&e| e != 0) {
                used[(l2_start + i as u64) as usize] = true; // L2
            }
        }
        for c in data_start..next_data_cluster {
            used[c as usize] = true; // data
        }
        used[rc_table_cluster as usize] = true; // rc table
        for c in rc_block_start..total_clusters {
            used[c as usize] = true; // rc blocks
        }

        for bi in 0..num_rc_blocks {
            let block_offset = (rc_block_start + bi) * cluster_size;
            output
                .seek(SeekFrom::Start(block_offset))
                .map_err(|e| BoxliteError::Storage(format!("flatten: rc block seek: {}", e)))?;
            let first = (bi * rc_entries_per_block) as usize;
            for c in 0..rc_entries_per_block as usize {
                let refcount: u16 = if first + c < used.len() && used[first + c] {
                    1
                } else {
                    0
                };
                output.write_all(&refcount.to_be_bytes()).map_err(|e| {
                    BoxliteError::Storage(format!("flatten: rc block write: {}", e))
                })?;
            }
        }

        // Phase 7: Write QCOW2 v3 header at cluster 0 (standalone, no backing).
        output
            .seek(SeekFrom::Start(0))
            .map_err(|e| BoxliteError::Storage(format!("flatten: header seek: {}", e)))?;
        let mut hdr = [0u8; 112]; // 104 bytes header + 8 bytes end-of-extensions
        // Magic
        hdr[0..4].copy_from_slice(&QCOW2_MAGIC.to_be_bytes());
        // Version 3
        hdr[4..8].copy_from_slice(&3u32.to_be_bytes());
        // No backing file (offset=0, size=0) — bytes 8-19 stay zero
        // Cluster bits
        hdr[20..24].copy_from_slice(&cluster_bits.to_be_bytes());
        // Virtual size
        hdr[24..32].copy_from_slice(&virtual_size.to_be_bytes());
        // Crypt method 0
        // L1 size
        hdr[36..40].copy_from_slice(&num_l1.to_be_bytes());
        // L1 table offset (cluster 1)
        hdr[40..48].copy_from_slice(&cluster_size.to_be_bytes());
        // Refcount table offset
        hdr[48..56].copy_from_slice(&rc_table_offset.to_be_bytes());
        // Refcount table clusters
        hdr[56..60].copy_from_slice(&1u32.to_be_bytes());
        // Refcount order (4 = 16-bit)
        hdr[96..100].copy_from_slice(&(REFCOUNT_ORDER as u32).to_be_bytes());
        // Header length
        hdr[100..104].copy_from_slice(&104u32.to_be_bytes());
        // Bytes 104-111: end-of-extensions marker (all zeros, already initialized)
        output
            .write_all(&hdr)
            .map_err(|e| BoxliteError::Storage(format!("flatten: header write: {}", e)))?;

        output
            .sync_all()
            .map_err(|e| BoxliteError::Storage(format!("flatten: sync: {}", e)))?;

        tracing::info!(
            dst = %dst.display(),
            data_clusters = next_data_cluster - data_start,
            "Flattened QCOW2 disk image"
        );

        Ok(())
    }

    /// Open the full backing chain starting from `path`.
    ///
    /// Returns layers from top (index 0) to base (last index).
    fn open_flatten_chain(path: &Path) -> BoxliteResult<Vec<FlattenLayer>> {
        let mut chain = Vec::new();
        let mut current_path = path.to_path_buf();

        loop {
            let (layer, backing) = FlattenLayer::open(&current_path)?;
            chain.push(layer);
            match backing {
                Some(bp) => current_path = PathBuf::from(bp),
                None => break,
            }
        }

        if chain.is_empty() {
            return Err(BoxliteError::Storage("flatten: empty backing chain".into()));
        }

        Ok(chain)
    }

    /// Read qcow2 header from disk file.
    #[allow(dead_code)]
    fn read_qcow2_header(path: &Path) -> BoxliteResult<Qcow2HeaderInfo> {
        use std::io::Read;

        let mut file = std::fs::File::open(path).map_err(|e| {
            BoxliteError::Storage(format!("Failed to open {}: {}", path.display(), e))
        })?;

        let mut header = [0u8; 104]; // qcow2 header is 104 bytes (v3)
        file.read_exact(&mut header).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read header from {}: {}",
                path.display(),
                e
            ))
        })?;

        // Parse qcow2 header (big-endian)
        let magic = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
        if magic != 0x514649fb {
            // "QFI\xfb"
            return Err(BoxliteError::Storage(format!(
                "Invalid qcow2 magic in {}: 0x{:08x}",
                path.display(),
                magic
            )));
        }

        let version = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
        let size = u64::from_be_bytes([
            header[24], header[25], header[26], header[27], header[28], header[29], header[30],
            header[31],
        ]);
        let cluster_bits = u32::from_be_bytes([header[20], header[21], header[22], header[23]]);

        Ok(Qcow2HeaderInfo {
            version,
            size,
            cluster_bits,
        })
    }

    /// Write a qcow2 v3 header with backing file reference.
    ///
    /// Creates a qcow2 file that uses another file as backing store for COW.
    /// The child starts empty - all reads go to backing file.
    fn write_cow_child_header(
        child_path: &Path,
        backing_path: &Path,
        backing_format: BackingFormat,
        virtual_size: u64,
    ) -> BoxliteResult<()> {
        use std::io::Write;

        // Get absolute path for backing file
        let backing_str = backing_path
            .canonicalize()
            .map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to canonicalize backing path {}: {}",
                    backing_path.display(),
                    e
                ))
            })?
            .to_string_lossy()
            .to_string();

        let backing_bytes = backing_str.as_bytes();
        let backing_len = backing_bytes.len() as u32;

        // Backing format string for extension header
        let format_str = backing_format.as_str();
        let format_bytes = format_str.as_bytes();
        let format_len = format_bytes.len() as u32;

        // qcow2 v3 header layout:
        // 0-3:   magic (QFI\xfb)
        // 4-7:   version (3)
        // 8-15:  backing_file_offset
        // 16-19: backing_file_size
        // 20-23: cluster_bits (16 = 64KB clusters)
        // 24-31: size (virtual disk size)
        // 32-35: crypt_method (0 = none)
        // 36-39: l1_size
        // 40-47: l1_table_offset
        // 48-55: refcount_table_offset
        // 56-59: refcount_table_clusters
        // 60-63: nb_snapshots
        // 64-71: snapshots_offset
        // 72-79: incompatible_features
        // 80-87: compatible_features
        // 88-95: autoclear_features
        // 96-99: refcount_order (4 = 16-bit)
        // 100-103: header_length

        let cluster_bits: u32 = CLUSTER_BITS as u32;
        let cluster_size: u64 = 1u64 << cluster_bits;

        // Backing file goes right after the header (at offset 512)
        let backing_offset: u64 = 512;

        // L1 table calculation - correctly size L1 table for large disks
        // L2 covers cluster_size/8 clusters per L2 table (each L2 entry is 8 bytes)
        // L1 entries = ceil(virtual_size / bytes_per_l2) where bytes_per_l2 = (cluster_size/8) * cluster_size
        let l2_entries_per_table = cluster_size / 8; // entries per L2 table
        let bytes_per_l2 = l2_entries_per_table * cluster_size; // bytes covered by one L2 table
        let l1_entries = virtual_size.div_ceil(bytes_per_l2) as u32;
        let l1_size = l1_entries;
        let l1_offset = cluster_size;

        // Calculate how many clusters the L1 table needs
        let l1_bytes = (l1_entries as u64) * 8; // each L1 entry is 8 bytes
        let l1_clusters = l1_bytes.div_ceil(cluster_size);

        // Place refcount table after L1 table (not at fixed cluster 2!)
        let refcount_table_cluster = 1 + l1_clusters; // cluster after L1
        let refcount_offset = cluster_size * refcount_table_cluster;
        let refcount_clusters = 1u32;

        // Refcount block is one cluster after refcount table
        let refcount_block_cluster = refcount_table_cluster + 1;
        let refcount_block_offset = cluster_size * refcount_block_cluster;

        // Total clusters needed: header(1) + L1(l1_clusters) + refcount_table(1) + refcount_block(1)
        let total_clusters = 1 + l1_clusters + 2;

        // Header extension starts at offset 104
        let header_extension_offset = 104usize;

        // Allocate buffer for all structures
        let mut header = vec![0u8; (cluster_size as usize) * (total_clusters as usize)];

        // Write qcow2 v3 header
        // Magic (QFI\xfb)
        header[0..4].copy_from_slice(&0x514649fbu32.to_be_bytes());
        // Version 3
        header[4..8].copy_from_slice(&3u32.to_be_bytes());
        // Backing file offset
        header[8..16].copy_from_slice(&backing_offset.to_be_bytes());
        // Backing file size
        header[16..20].copy_from_slice(&backing_len.to_be_bytes());
        // Cluster bits
        header[20..24].copy_from_slice(&cluster_bits.to_be_bytes());
        // Virtual size
        header[24..32].copy_from_slice(&virtual_size.to_be_bytes());
        // Crypt method (0 = none)
        header[32..36].copy_from_slice(&0u32.to_be_bytes());
        // L1 size
        header[36..40].copy_from_slice(&l1_size.to_be_bytes());
        // L1 table offset
        header[40..48].copy_from_slice(&l1_offset.to_be_bytes());
        // Refcount table offset
        header[48..56].copy_from_slice(&refcount_offset.to_be_bytes());
        // Refcount table clusters
        header[56..60].copy_from_slice(&refcount_clusters.to_be_bytes());
        // Snapshots (0)
        header[60..64].copy_from_slice(&0u32.to_be_bytes());
        // Snapshots offset (0)
        header[64..72].copy_from_slice(&0u64.to_be_bytes());
        // Incompatible features (0)
        header[72..80].copy_from_slice(&0u64.to_be_bytes());
        // Compatible features (0)
        header[80..88].copy_from_slice(&0u64.to_be_bytes());
        // Autoclear features (0)
        header[88..96].copy_from_slice(&0u64.to_be_bytes());
        // Refcount order (4 = 16-bit refcounts)
        header[96..100].copy_from_slice(&(REFCOUNT_ORDER as u32).to_be_bytes());
        // Header length (104 for v3)
        header[100..104].copy_from_slice(&104u32.to_be_bytes());

        // Write backing format extension (type 0xE2792ACA)
        // This tells QEMU/libkrun the backing file format
        // Extension type: backing format (0xE2792ACA)
        header[header_extension_offset..header_extension_offset + 4]
            .copy_from_slice(&0xE2792ACAu32.to_be_bytes());
        // Extension length
        header[header_extension_offset + 4..header_extension_offset + 8]
            .copy_from_slice(&format_len.to_be_bytes());
        // Extension data (format string, padded to 8-byte boundary)
        header[header_extension_offset + 8..header_extension_offset + 8 + format_bytes.len()]
            .copy_from_slice(format_bytes);

        // End of extensions marker (type 0)
        let end_ext_offset = header_extension_offset + 8 + ((format_len as usize + 7) & !7);
        header[end_ext_offset..end_ext_offset + 4].copy_from_slice(&0u32.to_be_bytes());
        header[end_ext_offset + 4..end_ext_offset + 8].copy_from_slice(&0u32.to_be_bytes());

        // Write backing file path at offset 512
        header[backing_offset as usize..backing_offset as usize + backing_bytes.len()]
            .copy_from_slice(backing_bytes);

        // L1 table at cluster 1 - all zeros means all reads go to backing file
        // (already zero-initialized)

        // Refcount table - first entry points to refcount block
        let rt_offset = refcount_offset as usize;
        header[rt_offset..rt_offset + 8].copy_from_slice(&refcount_block_offset.to_be_bytes());

        // Refcount block: mark all used clusters as used (refcount = 1)
        // Used clusters: 0 (header), 1..1+l1_clusters (L1 table), refcount_table, refcount_block
        let rb_offset = refcount_block_offset as usize;
        for i in 0..total_clusters {
            // 16-bit refcounts (refcount_order = 4 means 2^4 = 16 bits)
            let offset = rb_offset + (i as usize) * 2;
            header[offset..offset + 2].copy_from_slice(&1u16.to_be_bytes());
        }

        // Write to file
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(child_path)
            .map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create child disk {}: {}",
                    child_path.display(),
                    e
                ))
            })?;

        file.write_all(&header).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to write COW child header to {}: {}",
                child_path.display(),
                e
            ))
        })?;

        // Sync to disk to ensure header is durable before returning.
        // Without this, the header may stay in page cache and be lost if the
        // process exits before the kernel flushes it (causing EINVAL on restart).
        file.sync_all().map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to sync COW child disk {}: {}",
                child_path.display(),
                e
            ))
        })?;

        Ok(())
    }

    /// Create COW child disk using external qemu-img binary.
    #[allow(dead_code)]
    fn create_cow_child_disk_external(base_disk: &Path, child_path: &Path) -> BoxliteResult<Disk> {
        // Ensure parent directory exists
        if let Some(parent) = child_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create parent directory {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }

        if child_path.exists() {
            tracing::debug!("Child disk already exists: {}", child_path.display());
            return Ok(Disk::new(
                child_path.to_path_buf(),
                DiskFormat::Qcow2,
                false,
            ));
        }

        tracing::info!(
            "Creating COW child disk: {} (backing: {})",
            child_path.display(),
            base_disk.display()
        );

        // Use qemu-img to create child with backing file
        // Equivalent to: qemu-img create -f qcow2 -b base.qcow2 -F qcow2 child.qcow2
        let output = Command::new("qemu-img")
            .args(["create", "-f", "qcow2"])
            .arg("-b")
            .arg(base_disk)
            .arg("-F")
            .arg("qcow2")
            .arg(child_path)
            .output()
            .map_err(|e| {
                BoxliteError::Storage(format!("Failed to run qemu-img (is it installed?): {}", e))
            })?;

        if !output.status.success() {
            return Err(BoxliteError::Storage(format!(
                "Failed to create COW child disk {}: {}",
                child_path.display(),
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        tracing::info!("Created COW child disk: {}", child_path.display());
        // COW children are per-box, should be cleaned up
        Ok(Disk::new(
            child_path.to_path_buf(),
            DiskFormat::Qcow2,
            false,
        ))
    }
}

/// Read the backing file path from a qcow2 disk image header.
///
/// Returns `None` if the qcow2 has no backing file (offset or size is 0).
/// Returns `Err` if the file is not a valid qcow2 image.
pub fn read_backing_file_path(path: &Path) -> BoxliteResult<Option<String>> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).map_err(|e| {
        BoxliteError::Storage(format!("Failed to open qcow2 {}: {}", path.display(), e))
    })?;

    // Read the first 20 bytes of the header
    let mut header = [0u8; 20];
    file.read_exact(&mut header).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to read qcow2 header from {}: {}",
            path.display(),
            e
        ))
    })?;

    // Verify magic
    let magic = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    if magic != 0x514649fb {
        return Err(BoxliteError::Storage(format!(
            "Invalid qcow2 magic in {}: 0x{:08x}",
            path.display(),
            magic
        )));
    }

    // Backing file offset (bytes 8-15) and size (bytes 16-19)
    let backing_offset = u64::from_be_bytes([
        header[8], header[9], header[10], header[11], header[12], header[13], header[14],
        header[15],
    ]);
    let backing_size = u32::from_be_bytes([header[16], header[17], header[18], header[19]]);

    if backing_offset == 0 || backing_size == 0 {
        return Ok(None);
    }

    // Read backing file path
    file.seek(SeekFrom::Start(backing_offset)).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to seek to backing file path in {}: {}",
            path.display(),
            e
        ))
    })?;

    let mut backing_buf = vec![0u8; backing_size as usize];
    file.read_exact(&mut backing_buf).map_err(|e| {
        BoxliteError::Storage(format!(
            "Failed to read backing file path from {}: {}",
            path.display(),
            e
        ))
    })?;

    let backing_path = String::from_utf8(backing_buf).map_err(|e| {
        BoxliteError::Storage(format!(
            "Invalid UTF-8 in backing file path of {}: {}",
            path.display(),
            e
        ))
    })?;

    Ok(Some(backing_path))
}

/// QCOW2 magic number: "QFI\xfb".
const QCOW2_MAGIC: u32 = 0x514649fb;

/// A layer in a QCOW2 backing chain, used during flatten.
enum FlattenLayer {
    /// A QCOW2 layer with L1/L2 indirection.
    Qcow2 {
        file: std::fs::File,
        cluster_bits: u32,
        virtual_size: u64,
        l1_table: Vec<u64>,
    },
    /// A raw (non-QCOW2) base image.
    Raw { file: std::fs::File, size: u64 },
}

impl FlattenLayer {
    /// Open a file and determine if it's QCOW2 or raw.
    ///
    /// For QCOW2: parses header and reads L1 table.
    /// For raw: just records file size.
    fn open(path: &Path) -> BoxliteResult<(Self, Option<String>)> {
        use std::io::{Read, Seek, SeekFrom};

        let mut file = std::fs::File::open(path).map_err(|e| {
            BoxliteError::Storage(format!("Failed to open {}: {}", path.display(), e))
        })?;

        let mut magic_buf = [0u8; 4];
        file.read_exact(&mut magic_buf).map_err(|e| {
            BoxliteError::Storage(format!("Failed to read {}: {}", path.display(), e))
        })?;

        let magic = u32::from_be_bytes(magic_buf);
        if magic != QCOW2_MAGIC {
            // Raw file — no backing chain.
            let size = file
                .metadata()
                .map_err(|e| {
                    BoxliteError::Storage(format!("Failed to stat {}: {}", path.display(), e))
                })?
                .len();
            return Ok((FlattenLayer::Raw { file, size }, None));
        }

        // Parse QCOW2 header.
        let mut hdr = [0u8; 104];
        file.seek(SeekFrom::Start(0)).unwrap();
        file.read_exact(&mut hdr).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read QCOW2 header from {}: {}",
                path.display(),
                e
            ))
        })?;

        let backing_offset = u64::from_be_bytes(hdr[8..16].try_into().unwrap());
        let backing_size = u32::from_be_bytes(hdr[16..20].try_into().unwrap());
        let cluster_bits = u32::from_be_bytes(hdr[20..24].try_into().unwrap());
        let virtual_size = u64::from_be_bytes(hdr[24..32].try_into().unwrap());
        let l1_size = u32::from_be_bytes(hdr[36..40].try_into().unwrap());
        let l1_offset = u64::from_be_bytes(hdr[40..48].try_into().unwrap());

        // Read backing file path (if any).
        let backing = if backing_offset != 0 && backing_size != 0 {
            file.seek(SeekFrom::Start(backing_offset)).map_err(|e| {
                BoxliteError::Storage(format!("Failed to seek in {}: {}", path.display(), e))
            })?;
            let mut buf = vec![0u8; backing_size as usize];
            file.read_exact(&mut buf).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to read backing path from {}: {}",
                    path.display(),
                    e
                ))
            })?;
            Some(String::from_utf8(buf).map_err(|e| {
                BoxliteError::Storage(format!("Invalid backing path in {}: {}", path.display(), e))
            })?)
        } else {
            None
        };

        // Read L1 table.
        file.seek(SeekFrom::Start(l1_offset)).map_err(|e| {
            BoxliteError::Storage(format!("Failed to seek to L1 in {}: {}", path.display(), e))
        })?;
        let mut l1_buf = vec![0u8; (l1_size as usize) * 8];
        file.read_exact(&mut l1_buf).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read L1 table from {}: {}",
                path.display(),
                e
            ))
        })?;
        let l1_table: Vec<u64> = l1_buf
            .chunks_exact(8)
            .map(|c| u64::from_be_bytes(c.try_into().unwrap()))
            .collect();

        Ok((
            FlattenLayer::Qcow2 {
                file,
                cluster_bits,
                virtual_size,
                l1_table,
            },
            backing,
        ))
    }

    /// Read a single virtual cluster from this layer.
    ///
    /// Returns `Some(data)` if the cluster is allocated in this layer,
    /// `None` if unallocated (should fall through to backing layer).
    fn read_cluster(
        &mut self,
        virtual_cluster: u64,
        cluster_size: u64,
    ) -> BoxliteResult<Option<Vec<u8>>> {
        use std::io::{Read, Seek, SeekFrom};

        match self {
            FlattenLayer::Raw { file, size } => {
                let offset = virtual_cluster * cluster_size;
                if offset >= *size {
                    return Ok(None);
                }
                file.seek(SeekFrom::Start(offset))
                    .map_err(|e| BoxliteError::Storage(format!("flatten: raw seek: {}", e)))?;
                let mut buf = vec![0u8; cluster_size as usize];
                let remaining = (*size - offset).min(cluster_size) as usize;
                file.read_exact(&mut buf[..remaining])
                    .map_err(|e| BoxliteError::Storage(format!("flatten: raw read: {}", e)))?;
                Ok(Some(buf))
            }
            FlattenLayer::Qcow2 {
                file,
                cluster_bits,
                l1_table,
                ..
            } => {
                let cs = 1u64 << *cluster_bits;
                let l2_entries = cs / 8;
                let l1_idx = (virtual_cluster / l2_entries) as usize;
                let l2_idx = virtual_cluster % l2_entries;

                if l1_idx >= l1_table.len() {
                    return Ok(None);
                }

                // L1 entry: bits 9-55 hold the L2 table offset.
                let l2_table_offset = l1_table[l1_idx] & 0x00FF_FFFF_FFFF_FE00;
                if l2_table_offset == 0 {
                    return Ok(None);
                }

                // Read the single L2 entry we need.
                let l2_entry_offset = l2_table_offset + l2_idx * 8;
                file.seek(SeekFrom::Start(l2_entry_offset))
                    .map_err(|e| BoxliteError::Storage(format!("flatten: L2 seek: {}", e)))?;
                let mut entry_buf = [0u8; 8];
                file.read_exact(&mut entry_buf)
                    .map_err(|e| BoxliteError::Storage(format!("flatten: L2 read: {}", e)))?;
                let l2_entry = u64::from_be_bytes(entry_buf);

                // Bit 62: compressed cluster (not supported).
                if l2_entry & (1 << 62) != 0 {
                    return Err(BoxliteError::Storage(
                        "flatten: compressed QCOW2 clusters are not supported".into(),
                    ));
                }

                let data_offset = l2_entry & 0x00FF_FFFF_FFFF_FE00;
                if data_offset == 0 {
                    return Ok(None); // Unallocated — fall through to backing.
                }

                file.seek(SeekFrom::Start(data_offset))
                    .map_err(|e| BoxliteError::Storage(format!("flatten: data seek: {}", e)))?;
                let mut buf = vec![0u8; cs as usize];
                file.read_exact(&mut buf)
                    .map_err(|e| BoxliteError::Storage(format!("flatten: data read: {}", e)))?;
                Ok(Some(buf))
            }
        }
    }
}

/// Backing file format for qcow2 COW overlays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackingFormat {
    /// Raw disk image (ext4, etc.)
    Raw,
    /// Qcow2 disk image.
    #[allow(dead_code)]
    Qcow2,
}

impl BackingFormat {
    /// Get format string for qcow2 backing format extension.
    pub fn as_str(&self) -> &'static str {
        match self {
            BackingFormat::Raw => "raw",
            BackingFormat::Qcow2 => "qcow2",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// Build a minimal qcow2 file with optional backing file.
    fn write_qcow2_with_backing(path: &Path, backing_path: Option<&str>) {
        let mut buf = vec![0u8; 1024];

        // Magic: QFI\xfb
        buf[0..4].copy_from_slice(&0x514649fbu32.to_be_bytes());
        // Version: 3
        buf[4..8].copy_from_slice(&3u32.to_be_bytes());

        if let Some(backing) = backing_path {
            let backing_bytes = backing.as_bytes();
            let backing_offset: u64 = 512;
            let backing_size = backing_bytes.len() as u32;

            buf[8..16].copy_from_slice(&backing_offset.to_be_bytes());
            buf[16..20].copy_from_slice(&backing_size.to_be_bytes());
            buf[backing_offset as usize..backing_offset as usize + backing_bytes.len()]
                .copy_from_slice(backing_bytes);
        }
        // else: offset=0, size=0 (no backing file)

        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(&buf).unwrap();
    }

    #[test]
    fn test_read_backing_file_path_with_backing() {
        let dir = TempDir::new().unwrap();
        let qcow2_path = dir.path().join("test.qcow2");

        write_qcow2_with_backing(&qcow2_path, Some("/data/rootfs/base.ext4"));

        let result = read_backing_file_path(&qcow2_path).unwrap();
        assert_eq!(result, Some("/data/rootfs/base.ext4".to_string()));
    }

    #[test]
    fn test_read_backing_file_path_no_backing() {
        let dir = TempDir::new().unwrap();
        let qcow2_path = dir.path().join("test.qcow2");

        write_qcow2_with_backing(&qcow2_path, None);

        let result = read_backing_file_path(&qcow2_path).unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn test_read_backing_file_path_invalid_magic() {
        let dir = TempDir::new().unwrap();
        let qcow2_path = dir.path().join("bad.qcow2");

        // Write a file with wrong magic bytes
        let mut buf = vec![0u8; 64];
        buf[0..4].copy_from_slice(&0xDEADBEEFu32.to_be_bytes());
        std::fs::write(&qcow2_path, &buf).unwrap();

        let result = read_backing_file_path(&qcow2_path);
        assert!(result.is_err());
        let err_msg = format!("{}", result.unwrap_err());
        assert!(err_msg.contains("Invalid qcow2 magic"));
    }

    #[test]
    fn test_read_backing_file_path_file_too_short() {
        let dir = TempDir::new().unwrap();
        let qcow2_path = dir.path().join("short.qcow2");

        // Write only 10 bytes (less than required 20)
        std::fs::write(&qcow2_path, [0u8; 10]).unwrap();

        let result = read_backing_file_path(&qcow2_path);
        assert!(result.is_err());
    }

    #[test]
    fn test_read_backing_file_path_nonexistent_file() {
        let result = read_backing_file_path(Path::new("/nonexistent/file.qcow2"));
        assert!(result.is_err());
    }

    #[test]
    fn test_backing_format_as_str() {
        assert_eq!(BackingFormat::Raw.as_str(), "raw");
        assert_eq!(BackingFormat::Qcow2.as_str(), "qcow2");
    }

    // ── Flatten tests ──────────────────────────────────────────────────

    /// Create a small raw disk file with a known pattern.
    fn write_raw_disk(path: &Path, size: u64) {
        let mut data = vec![0u8; size as usize];
        // Write a recognizable pattern in the first few bytes of each 64KB cluster.
        let cluster_size = 1u64 << CLUSTER_BITS;
        let mut cluster_idx = 0u64;
        while cluster_idx * cluster_size < size {
            let offset = (cluster_idx * cluster_size) as usize;
            if offset + 8 <= data.len() {
                // Pattern: (cluster_idx + 1) so cluster 0 is non-zero.
                let marker = cluster_idx + 1;
                data[offset..offset + 8].copy_from_slice(&marker.to_be_bytes());
            }
            cluster_idx += 1;
        }
        std::fs::write(path, &data).unwrap();
    }

    /// Verify that a flattened QCOW2 file is standalone (no backing) and
    /// can be read through FlattenLayer to get expected data.
    fn verify_flatten_output(path: &Path, expected_virtual_size: u64) {
        // Should have no backing file.
        let backing = read_backing_file_path(path).unwrap();
        assert_eq!(backing, None, "flattened file should have no backing");

        // Should parse as QCOW2.
        let (layer, backing) = FlattenLayer::open(path).unwrap();
        assert!(backing.is_none());
        match &layer {
            FlattenLayer::Qcow2 { virtual_size, .. } => {
                assert_eq!(*virtual_size, expected_virtual_size);
            }
            FlattenLayer::Raw { .. } => panic!("expected QCOW2, got raw"),
        }
    }

    #[test]
    fn test_flatten_standalone_qcow2() {
        // Flatten a standalone QCOW2 (no backing) → should produce a valid standalone copy.
        let dir = TempDir::new().unwrap();
        // Create a standalone QCOW2 via create_disk.
        let src = dir.path().join("src.qcow2");
        let _disk = Qcow2Helper::create_disk(&src, true).unwrap();

        let dst = dir.path().join("dst.qcow2");
        Qcow2Helper::flatten(&src, &dst).unwrap();

        verify_flatten_output(&dst, DEFAULT_DISK_SIZE_GB * 1024 * 1024 * 1024);
    }

    #[test]
    fn test_flatten_two_layer_chain() {
        // Raw base → QCOW2 child → flatten.
        let dir = TempDir::new().unwrap();
        let cluster_size = 1u64 << CLUSTER_BITS;
        let raw_size = cluster_size * 4;

        // Create raw base with known data.
        let base = dir.path().join("base.raw");
        write_raw_disk(&base, raw_size);

        // Create COW child pointing to the raw base.
        let child = dir.path().join("child.qcow2");
        let _child_disk =
            Qcow2Helper::create_cow_child_disk(&base, BackingFormat::Raw, &child, raw_size)
                .unwrap();

        // Flatten.
        let dst = dir.path().join("flat.qcow2");
        Qcow2Helper::flatten(&child, &dst).unwrap();

        verify_flatten_output(&dst, raw_size);

        // Read cluster 0 from the flattened file — should have our pattern.
        let mut chain = Qcow2Helper::open_flatten_chain(&dst).unwrap();
        let data = chain[0].read_cluster(0, cluster_size).unwrap();
        assert!(data.is_some(), "cluster 0 should have data");
        let d = data.unwrap();
        let val = u64::from_be_bytes(d[0..8].try_into().unwrap());
        assert_eq!(val, 1, "cluster 0 marker should be 1 (cluster_idx + 1)");

        // Read cluster 2.
        let data = chain[0].read_cluster(2, cluster_size).unwrap();
        assert!(data.is_some(), "cluster 2 should have data");
        let d = data.unwrap();
        let val = u64::from_be_bytes(d[0..8].try_into().unwrap());
        assert_eq!(val, 3, "cluster 2 marker should be 3 (cluster_idx + 1)");
    }

    #[test]
    fn test_flatten_three_layer_chain() {
        // Raw base → QCOW2 mid → QCOW2 top → flatten.
        // The mid layer adds no new data; top layer adds no new data.
        // All data comes from the raw base.
        let dir = TempDir::new().unwrap();
        let cluster_size = 1u64 << CLUSTER_BITS;
        let raw_size = cluster_size * 2;

        let base = dir.path().join("base.raw");
        write_raw_disk(&base, raw_size);

        let mid = dir.path().join("mid.qcow2");
        let _mid_disk =
            Qcow2Helper::create_cow_child_disk(&base, BackingFormat::Raw, &mid, raw_size).unwrap();

        let top = dir.path().join("top.qcow2");
        let _top_disk =
            Qcow2Helper::create_cow_child_disk(&mid, BackingFormat::Qcow2, &top, raw_size).unwrap();

        let dst = dir.path().join("flat.qcow2");
        Qcow2Helper::flatten(&top, &dst).unwrap();

        verify_flatten_output(&dst, raw_size);

        // Verify data from base propagated through.
        let mut chain = Qcow2Helper::open_flatten_chain(&dst).unwrap();
        let data = chain[0].read_cluster(1, cluster_size).unwrap();
        assert!(data.is_some());
        let val = u64::from_be_bytes(data.unwrap()[0..8].try_into().unwrap());
        assert_eq!(val, 2, "cluster 1 marker should be 2 (cluster_idx + 1)");
    }

    #[test]
    fn test_flatten_compressed_cluster_errors() {
        // Create a QCOW2 with a manually crafted compressed L2 entry.
        let dir = TempDir::new().unwrap();
        let cluster_size = 1u64 << CLUSTER_BITS;
        let virtual_size = cluster_size * 2;

        // Create a raw base.
        let base = dir.path().join("base.raw");
        write_raw_disk(&base, virtual_size);

        // Create a QCOW2 child, then tamper with its L2 table to set bit 62.
        let child = dir.path().join("child.qcow2");
        let _child_disk =
            Qcow2Helper::create_cow_child_disk(&base, BackingFormat::Raw, &child, virtual_size)
                .unwrap();

        // Read the child's L1 table to find L2 offset, then write a fake compressed entry.
        {
            use std::io::{Read, Seek, SeekFrom};

            let mut f = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&child)
                .unwrap();

            // Read header to get L1 offset and L1 size.
            let mut hdr = [0u8; 48];
            f.read_exact(&mut hdr).unwrap();
            let l1_size = u32::from_be_bytes(hdr[36..40].try_into().unwrap());
            let l1_offset = u64::from_be_bytes(hdr[40..48].try_into().unwrap());

            if l1_size == 0 {
                // Can't test without L1 entries — skip gracefully.
                return;
            }

            // Read first L1 entry.
            f.seek(SeekFrom::Start(l1_offset)).unwrap();
            let mut l1_buf = [0u8; 8];
            f.read_exact(&mut l1_buf).unwrap();
            let l1_entry = u64::from_be_bytes(l1_buf);
            let l2_offset = l1_entry & 0x00FF_FFFF_FFFF_FE00;

            if l2_offset == 0 {
                // L1 doesn't point to an L2 table (child has no written data).
                // Write a fake L1 entry pointing to a new cluster with a compressed L2 entry.
                // Use the cluster right after the header metadata.
                let fake_l2_cluster = 10u64 * cluster_size; // far enough from header
                let fake_l1 = fake_l2_cluster;

                // Write L1 entry.
                f.seek(SeekFrom::Start(l1_offset)).unwrap();
                f.write_all(&fake_l1.to_be_bytes()).unwrap();

                // Write a compressed L2 entry at the fake L2 table.
                f.seek(SeekFrom::Start(fake_l2_cluster)).unwrap();
                let compressed_entry: u64 = 1u64 << 62; // bit 62 = compressed
                f.write_all(&compressed_entry.to_be_bytes()).unwrap();
            } else {
                // Overwrite first L2 entry with compressed flag.
                f.seek(SeekFrom::Start(l2_offset)).unwrap();
                let compressed_entry: u64 = 1u64 << 62;
                f.write_all(&compressed_entry.to_be_bytes()).unwrap();
            }
        }

        let dst = dir.path().join("flat.qcow2");
        let result = Qcow2Helper::flatten(&child, &dst);
        assert!(result.is_err());
        let err = format!("{}", result.unwrap_err());
        assert!(
            err.contains("compressed"),
            "error should mention compressed clusters, got: {}",
            err
        );
    }
}
