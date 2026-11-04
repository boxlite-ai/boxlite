// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The chains a backend still holds: each deferred chain's head index and
//! result targets, by the token its request was submitted with.

use super::request::Targets;

/// One deferred chain.
#[derive(Debug)]
struct Entry {
    token: u32,
    head: u16,
    targets: Targets,
}

/// The in-flight table of one activation.
#[derive(Debug, Default)]
pub(crate) struct Inflight {
    entries: Vec<Entry>,
    next_token: u32,
}

impl Inflight {
    /// The token the next submission uses. Tokens wrap after `u32::MAX`
    /// requests, far beyond the queue size that bounds the table.
    pub(crate) fn next_token(&mut self) -> u32 {
        let token = self.next_token;
        self.next_token = self.next_token.wrapping_add(1);
        token
    }

    /// Records the chain at `head` as deferred under `token`.
    pub(crate) fn insert(&mut self, token: u32, head: u16, targets: Targets) {
        self.entries.push(Entry {
            token,
            head,
            targets,
        });
    }

    /// Takes the chain submitted under `token`, if the table holds it.
    pub(crate) fn remove(&mut self, token: u32) -> Option<(u16, Targets)> {
        let index = self.entries.iter().position(|entry| entry.token == token)?;
        let entry = self.entries.swap_remove(index);
        Some((entry.head, entry.targets))
    }

    /// Whether no chain is deferred.
    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
