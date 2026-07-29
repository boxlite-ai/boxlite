// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! The body type shared by everything the proxy sends: our own fixed responses
//! and the bodies we relay from a box.

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Incoming;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type Body = BoxBody<Bytes, BoxError>;

pub fn full(chunk: impl Into<Bytes>) -> Body {
    Full::new(chunk.into())
        .map_err(|never| match never {})
        .boxed()
}

pub fn empty() -> Body {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

/// Relays an inbound or upstream body without buffering it.
pub fn stream(body: Incoming) -> Body {
    body.map_err(BoxError::from).boxed()
}

/// Same as [`stream`], for any body type. Lets the forwarding path be exercised
/// without a live hyper connection to produce an [`Incoming`].
pub fn relay<B>(body: B) -> Body
where
    B: hyper::body::Body<Data = Bytes> + Send + Sync + 'static,
    B::Error: Into<BoxError>,
{
    body.map_err(Into::into).boxed()
}

/// Ties the lifetime of `guard` to the body: it is dropped once the last byte
/// has been read or the client goes away. Used to keep per-request work — the
/// activity reporter — running for exactly as long as the response does.
pub fn guarded<G: Send + Sync + Unpin + 'static>(inner: Body, guard: G) -> Body {
    Guarded {
        inner,
        _guard: guard,
    }
    .boxed()
}

struct Guarded<G> {
    inner: Body,
    _guard: G,
}

impl<G: Send + Sync + Unpin + 'static> hyper::body::Body for Guarded<G> {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Self::Data>, Self::Error>>> {
        // `Body` is a boxed trait object and therefore `Unpin`.
        std::pin::Pin::new(&mut self.get_mut().inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        self.inner.size_hint()
    }
}
