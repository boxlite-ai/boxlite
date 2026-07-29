// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Helpers shared by unit tests.

use http_body_util::BodyExt;

use crate::body::Body;

pub async fn body_to_string(body: Body) -> String {
    let collected = body.collect().await.expect("body reads cleanly");
    String::from_utf8_lossy(&collected.to_bytes()).into_owned()
}
