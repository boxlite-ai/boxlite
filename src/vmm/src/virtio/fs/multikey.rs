// Copyright 2019 The Chromium OS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// Adapted for BoxLite from boxlite-ai/libkrun commit
// e12b9b3780ffa8df9f3e1797b217d13453479167, src/devices/src/virtio/fs/multikey.rs.
// BoxLite modifications: native VMM interfaces, Linux-only operation and
// explicit protocol validation and object ownership.

//! A two-key index. The caller owns synchronization of lookup, reference counts,
//! insertion and removal; inserting an existing identity never evicts its node.
use std::collections::BTreeMap;

pub(crate) struct MultikeyBTreeMap<K, A, V> {
    values: BTreeMap<K, (A, V)>,
    aliases: BTreeMap<A, K>,
}

impl<K: Ord + Clone, A: Ord + Clone, V> MultikeyBTreeMap<K, A, V> {
    pub(crate) fn new() -> Self {
        Self {
            values: BTreeMap::new(),
            aliases: BTreeMap::new(),
        }
    }

    pub(crate) fn get(&self, key: &K) -> Option<&V> {
        self.values.get(key).map(|(_, value)| value)
    }

    pub(crate) fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        self.values.get_mut(key).map(|(_, value)| value)
    }

    pub(crate) fn get_alt_key(&self, alias: &A) -> Option<K> {
        self.aliases.get(alias).cloned()
    }

    pub(crate) fn insert(&mut self, key: K, alias: A, value: V) -> bool {
        if self.values.contains_key(&key) || self.aliases.contains_key(&alias) {
            return false;
        }
        self.aliases.insert(alias.clone(), key.clone());
        self.values.insert(key, (alias, value));
        true
    }

    pub(crate) fn remove(&mut self, key: &K) -> Option<V> {
        self.values.remove(key).map(|(alias, value)| {
            self.aliases.remove(&alias);
            value
        })
    }
}
