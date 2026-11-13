//! OpenAPI-generated minimum releases, evaluated against the final wire request.

use std::sync::LazyLock;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use reqwest::{Request, Url};
use semver::Version;
use serde::Deserialize;
use serde_json::Value;

/// API version shared by servers and SDK builds.
pub fn api_version() -> &'static str {
    static VERSION: LazyLock<String> = LazyLock::new(|| {
        serde_json::from_str(include_str!("api_version.json")).expect("generated API version")
    });
    &VERSION
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(try_from = "String")]
enum Minimum {
    Released(Version),
    Unplanned,
}

impl TryFrom<String> for Minimum {
    type Error = semver::Error;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value == "unplanned" {
            Ok(Self::Unplanned)
        } else {
            Version::parse(&value).map(Self::Released)
        }
    }
}

impl std::fmt::Display for Minimum {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Released(version) => version.fmt(f),
            Self::Unplanned => f.write_str("unplanned"),
        }
    }
}

impl Minimum {
    fn cmp_precedence(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            (Self::Released(a), Self::Released(b)) => a.cmp_precedence(b),
            (Self::Unplanned, Self::Unplanned) => std::cmp::Ordering::Equal,
            (Self::Unplanned, _) => std::cmp::Ordering::Greater,
            (_, Self::Unplanned) => std::cmp::Ordering::Less,
        }
    }
}

static ROUTES: LazyLock<Vec<Route>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("version_rules.json"))
        .expect("generated OpenAPI version rules must be valid")
});

#[derive(Deserialize)]
struct Route {
    method: String,
    path: String,
    operation: String,
    minimum: Option<Minimum>,
    rules: Vec<FieldRule>,
}

#[derive(Deserialize)]
struct FieldRule {
    location: String,
    path: Vec<String>,
    minimum: Minimum,
    condition: String,
    #[serde(default)]
    default: Value,
    #[serde(rename = "type")]
    kind: Option<String>,
}

pub(super) struct Requirement<'a> {
    operation: &'a str,
    field: Option<&'a FieldRule>,
    minimum: &'a Minimum,
}

impl Requirement<'_> {
    pub(super) fn rejection(&self, reported: &str) -> BoxliteError {
        let field = self
            .field
            .map(|r| format!(" ({}.{})", r.location, r.path.join(".")))
            .unwrap_or_default();
        if *self.minimum == Minimum::Unplanned {
            return BoxliteError::Unsupported(format!(
                "{}{} is not yet supported (unplanned); no supporting server release is known. Omit this feature.",
                self.operation, field
            ));
        }
        BoxliteError::Unsupported(format!(
            "{}{} requires server >= {}; reported {}. Upgrade the server and recreate the client, or omit the unsupported feature.",
            self.operation, field, self.minimum, reported
        ))
    }

    pub(super) fn check(&self, server: &Version) -> BoxliteResult<()> {
        self.check_planned()?;
        let Minimum::Released(minimum) = self.minimum else {
            unreachable!()
        };
        if server.cmp_precedence(minimum).is_lt() {
            return Err(self.rejection(&server.to_string()));
        }
        Ok(())
    }

    pub(super) fn check_planned(&self) -> BoxliteResult<()> {
        if *self.minimum == Minimum::Unplanned {
            return Err(self.rejection("not checked"));
        }
        Ok(())
    }
}

/// Return the strongest triggered rule. Unannotated requests need no discovery.
pub(super) fn requirement(
    request: &Request,
    root: &Url,
    prefix: Option<&str>,
) -> BoxliteResult<Option<Requirement<'static>>> {
    evaluate(&ROUTES, request, root, prefix)
}

fn evaluate<'a>(
    routes: &'a [Route],
    request: &Request,
    root: &Url,
    prefix: Option<&str>,
) -> BoxliteResult<Option<Requirement<'a>>> {
    let path = request
        .url()
        .path()
        .strip_prefix(root.path())
        .filter(|_| request.url().origin() == root.origin())
        .ok_or_else(|| {
            BoxliteError::Internal("request is outside the configured Box REST base".into())
        })?;
    let prefix = prefix.filter(|s| !s.is_empty()).map(|s| format!("/{s}"));
    let route = routes
        .iter()
        .filter(|r| r.method == request.method().as_str())
        .filter(|r| {
            let (template, candidate) = route_path(&r.path, path, prefix.as_deref());
            matches_path(template, candidate)
        })
        .max_by_key(|r| r.path.split('/').filter(|s| !s.starts_with('{')).count())
        .ok_or_else(|| {
            BoxliteError::Internal(format!(
                "{} request has no matching OpenAPI operation; regenerate SDK version rules",
                request.method()
            ))
        })?;
    let mut required = route.minimum.as_ref().map(|minimum| Requirement {
        operation: &route.operation,
        field: None,
        minimum,
    });
    // JSON is inspected only where rules require it. Never consume a streamed
    // archive or rebuild a serialized body: this is a guard, not a serializer.
    let body = if route.rules.iter().any(|r| r.location == "body") {
        match request.body() {
            None => Value::Null,
            Some(body) => {
                let bytes = body.as_bytes().ok_or_else(|| {
                    BoxliteError::Internal("version rules require a buffered JSON body".into())
                })?;
                serde_json::from_slice(bytes).map_err(|_| {
                    BoxliteError::Internal("version rules could not decode the request JSON".into())
                })?
            }
        }
    } else {
        Value::Null
    };
    for rule in &route.rules {
        let values = match rule.location.as_str() {
            "body" => rule
                .path
                .iter()
                .try_fold(&body, |value, key| value.get(key))
                .cloned()
                .into_iter()
                .collect(),
            "query" => request
                .url()
                .query_pairs()
                .filter(|(k, _)| *k == rule.path[0])
                .map(|(_, v)| parameter_value(rule, &v))
                .collect::<BoxliteResult<Vec<_>>>()?,
            "header" => request
                .headers()
                .get_all(&rule.path[0])
                .iter()
                .map(|v| {
                    v.to_str()
                        .map_err(|_| BoxliteError::Internal("non-text versioned header".into()))
                        .and_then(|v| parameter_value(rule, v))
                })
                .collect::<BoxliteResult<Vec<_>>>()?,
            "path" => {
                let (template, candidate) = route_path(&route.path, path, prefix.as_deref());
                template
                    .split('/')
                    .zip(candidate.split('/'))
                    .filter(|(name, _)| *name == format!("{{{}}}", rule.path[0]))
                    .map(|(_, value)| {
                        urlencoding::decode(value)
                            .map_err(|_| {
                                BoxliteError::Internal("invalid versioned path parameter".into())
                            })
                            .and_then(|v| parameter_value(rule, &v))
                    })
                    .collect::<BoxliteResult<Vec<_>>>()?
            }
            _ => {
                return Err(BoxliteError::Internal(
                    "unsupported generated rule location".into(),
                ));
            }
        };
        if values
            .iter()
            .any(|v| rule.condition == "present" || v != &rule.default)
            && required.as_ref().is_none_or(|r| {
                rule.minimum == Minimum::Unplanned || rule.minimum.cmp_precedence(r.minimum).is_gt()
            })
        {
            required = Some(Requirement {
                operation: &route.operation,
                field: Some(rule),
                minimum: &rule.minimum,
            });
        }
    }
    Ok(required)
}

fn route_path<'a>(template: &'a str, path: &'a str, prefix: Option<&str>) -> (&'a str, &'a str) {
    match template.strip_prefix("/{prefix}") {
        Some(template) => (
            template,
            prefix.map_or(path, |p| path.strip_prefix(p).unwrap_or("")),
        ),
        None => (template, path),
    }
}

fn matches_path(template: &str, candidate: &str) -> bool {
    let a: Vec<_> = template.split('/').collect();
    let b: Vec<_> = candidate.split('/').collect();
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(a, b)| *a == b || (a.starts_with('{') && a.ends_with('}') && !b.is_empty()))
}

fn parameter_value(rule: &FieldRule, text: &str) -> BoxliteResult<Value> {
    if rule.kind.as_deref() == Some("string") {
        return Ok(Value::String(text.into()));
    }
    let value: Value = serde_json::from_str(text).map_err(|_| {
        BoxliteError::Internal(format!(
            "invalid versioned {} parameter {}",
            rule.location, rule.path[0]
        ))
    })?;
    let valid = match rule.kind.as_deref() {
        Some("boolean") => value.is_boolean(),
        Some("integer") => value.is_i64() || value.is_u64(),
        Some("number") => value.is_number(),
        _ => false,
    };
    if !valid {
        return Err(BoxliteError::Internal(format!(
            "wrong type for versioned parameter {}",
            rule.path[0]
        )));
    }
    Ok(value)
}

#[cfg(test)]
#[path = "tests/version_rules.rs"]
mod tests;
