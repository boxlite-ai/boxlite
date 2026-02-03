// Output formatting utilities for CLI commands.
// Provides unified formatting for different output formats (table, JSON, YAML, Go template).

use anyhow::{Result, anyhow};
use gtmpl::Value;
use gtmpl::{Context, Template};
use gtmpl_value::{FuncError, Value as GtmplValue};
use serde::Serialize;
use tabled::{Table, Tabled, settings::Style};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Table,
    Json,
    Yaml,
}

impl OutputFormat {
    /// Parse output format from string.
    ///
    /// # Examples
    ///
    /// ```
    /// use formatter::OutputFormat;
    /// ```
    pub fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "table" => Ok(Self::Table),
            "json" => Ok(Self::Json),
            "yaml" => Ok(Self::Yaml),
            _ => Err(anyhow!(
                "Unknown format: '{}'. Valid formats: table, json, yaml",
                s
            )),
        }
    }
}

/// Format data as JSON string.
pub fn format_json<T: Serialize>(data: &T) -> Result<String> {
    serde_json::to_string_pretty(data).map_err(|e| anyhow!("JSON serialization failed: {}", e))
}

/// Format data as YAML string.
pub fn format_yaml<T: Serialize>(data: &T) -> Result<String> {
    serde_yaml::to_string(data).map_err(|e| anyhow!("YAML serialization failed: {}", e))
}

/// Parsed Go-style template with "json" function (parse once, render many).
pub struct GtmplWithJson {
    tmpl: Template,
}

impl GtmplWithJson {
    /// Parse template string once. Use `render` for each context.
    pub fn parse(template_str: &str) -> Result<Self> {
        let json_func: gtmpl::Func = |args: &[Value]| -> std::result::Result<Value, FuncError> {
            let v = args
                .first()
                .ok_or_else(|| FuncError::ExactlyXArgs("json".into(), 1))?;
            let j = value_to_serde_json(v);
            let s = serde_json::to_string(&j).map_err(|e| FuncError::Generic(e.to_string()))?;
            Ok(Value::from(s))
        };
        let mut tmpl = Template::default();
        tmpl.add_func("json", json_func);
        tmpl.parse(template_str)
            .map_err(|e| anyhow!("Template parse error: {}", e))?;
        Ok(Self { tmpl })
    }

    pub fn render(&self, context: impl Into<Value>) -> Result<String> {
        let ctx = Context::from(context);
        self.tmpl
            .render(&ctx)
            .map_err(|e| anyhow!("Template error: {}", e))
    }
}

/// Convert a `serde_json::Value` to `gtmpl::Value` recursively.
/// Allows building gtmpl template context from any `Serialize` struct via `serde_json::to_value`.
pub fn value_from_serde_json(v: &serde_json::Value) -> Value {
    use serde_json::Value as JsonValue;
    match v {
        JsonValue::Object(m) => {
            let map: std::collections::HashMap<String, Value> = m
                .iter()
                .map(|(k, v)| (k.clone(), value_from_serde_json(v)))
                .collect();
            Value::from(map)
        }
        JsonValue::Array(arr) => {
            let vec: Vec<Value> = arr.iter().map(value_from_serde_json).collect();
            Value::from(vec)
        }
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else if let Some(f) = n.as_f64() {
                Value::from(f)
            } else {
                Value::from(0_i64)
            }
        }
        JsonValue::Bool(b) => Value::from(*b),
        JsonValue::String(s) => Value::from(s.as_str()),
        JsonValue::Null => Value::from(""),
    }
}

/// Convert gtmpl::Value to serde_json::Value (for json template function).
fn value_to_serde_json(v: &GtmplValue) -> serde_json::Value {
    use serde_json::Value as JsonValue;
    match v {
        GtmplValue::Object(m) | GtmplValue::Map(m) => {
            let obj: serde_json::Map<String, serde_json::Value> = m
                .iter()
                .map(|(k, val)| (k.clone(), value_to_serde_json(val)))
                .collect();
            JsonValue::Object(obj)
        }
        GtmplValue::Array(arr) => JsonValue::Array(arr.iter().map(value_to_serde_json).collect()),
        GtmplValue::String(s) => JsonValue::String(s.clone()),
        GtmplValue::Bool(b) => JsonValue::Bool(*b),
        GtmplValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                JsonValue::Number(serde_json::Number::from(i))
            } else if let Some(u) = n.as_u64() {
                JsonValue::Number(serde_json::Number::from(u))
            } else if let Some(f) = n.as_f64() {
                JsonValue::Number(
                    serde_json::Number::from_f64(f).unwrap_or(serde_json::Number::from(0)),
                )
            } else {
                JsonValue::Null
            }
        }
        GtmplValue::Nil | GtmplValue::NoValue | GtmplValue::Function(_) => JsonValue::Null,
    }
}

/// Format a JSON value in Go struct style: {Key1:value1 Key2:value2} (Podman/Docker aligned).
pub fn format_go_style_value(v: &serde_json::Value) -> String {
    use serde_json::Value as JsonValue;
    match v {
        JsonValue::Object(m) => {
            let parts: Vec<String> = m
                .iter()
                .map(|(k, val)| format!("{}:{}", k, format_go_style_value(val)))
                .collect();
            format!("{{{}}}", parts.join(" "))
        }
        JsonValue::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(format_go_style_value).collect();
            format!("[{}]", parts.join(" "))
        }
        JsonValue::String(s) => s.to_string(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Null => String::new(),
    }
}

/// Print data in the specified format to the provided writer.
///
/// For table format, uses the provided `table_printer` function.
/// For JSON/YAML, serializes the data and writes to the writer.
///
/// # Arguments
///
/// * `writer` - The writer to output to (e.g., stdout, file, buffer)
/// * `data` - The data to format (must implement `Serialize`)
/// * `format` - The output format
/// * `table_printer` - Function to print table format (only called for Table format)
///   The closure receives the writer and the data.
///
/// # Examples
///
/// ```no_run
/// use formatter::{OutputFormat, print_output};
/// use serde::Serialize;
/// use std::io::Write;
///
/// #[derive(Serialize)]
/// struct Data {
///     name: String,
///     value: i32,
/// }
///
/// let data = vec![Data { name: "test".into(), value: 20 }];
/// let mut buffer = Vec::new();
///
/// print_output(&mut buffer, &data, OutputFormat::Json, |_, _| {
///     // Table printer not called for JSON format
///     Ok(())
/// }).unwrap();
/// ```
pub fn print_output<T, W, F>(
    writer: &mut W,
    data: &T,
    format: OutputFormat,
    table_printer: F,
) -> Result<()>
where
    T: Serialize,
    W: std::io::Write,
    F: FnOnce(&mut W, &T) -> Result<()>,
{
    match format {
        OutputFormat::Table => {
            table_printer(writer, data)?;
            Ok(())
        }
        OutputFormat::Json => {
            let json = format_json(data)?;
            writeln!(writer, "{}", json)?;
            Ok(())
        }
        OutputFormat::Yaml => {
            let yaml = format_yaml(data)?;
            writeln!(writer, "{}", yaml)?;
            Ok(())
        }
    }
}

/// Format time consistently.
///
/// Uses the format: `YYYY-MM-DD HH:MM:SS TZ` (e.g., `2026-01-22 15:04:05 UTC`)
pub fn format_time<T: chrono::TimeZone>(t: &chrono::DateTime<T>) -> String
where
    T::Offset: std::fmt::Display,
{
    t.format("%Y-%m-%d %H:%M:%S %Z").to_string()
}

/// Create a standard table with Boxlite styling.
pub fn create_table<T: Tabled>(data: impl IntoIterator<Item = T>) -> Table {
    let mut table = Table::new(data);
    table.with(Style::sharp());
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde::Deserialize;

    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    struct TestData {
        name: String,
        value: i32,
    }

    #[test]
    fn test_output_format_from_str() {
        assert_eq!(
            OutputFormat::from_str("table").unwrap(),
            OutputFormat::Table
        );
        assert_eq!(
            OutputFormat::from_str("TABLE").unwrap(),
            OutputFormat::Table
        );
        assert_eq!(OutputFormat::from_str("json").unwrap(), OutputFormat::Json);
        assert_eq!(OutputFormat::from_str("JSON").unwrap(), OutputFormat::Json);
        assert_eq!(OutputFormat::from_str("yaml").unwrap(), OutputFormat::Yaml);
        assert_eq!(OutputFormat::from_str("YAML").unwrap(), OutputFormat::Yaml);
    }

    #[test]
    fn test_output_format_from_str_invalid() {
        let result = OutputFormat::from_str("invalid");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Unknown format"));
    }

    #[test]
    fn test_format_json() {
        let data = vec![
            TestData {
                name: "foo".into(),
                value: 1,
            },
            TestData {
                name: "bar".into(),
                value: 2,
            },
        ];

        let json = format_json(&data).unwrap();

        // Verify it's valid JSON
        let parsed: Vec<TestData> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "foo");
        assert_eq!(parsed[0].value, 1);
        assert_eq!(parsed[1].name, "bar");
        assert_eq!(parsed[1].value, 2);
    }

    #[test]
    fn test_format_json_single_item() {
        let data = TestData {
            name: "test".into(),
            value: 20,
        };
        let json = format_json(&data).unwrap();

        assert!(json.contains("test"));
        assert!(json.contains("20"));

        let parsed: TestData = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "test");
        assert_eq!(parsed.value, 20);
    }

    #[test]
    fn test_format_yaml() {
        let data = vec![
            TestData {
                name: "foo".into(),
                value: 1,
            },
            TestData {
                name: "bar".into(),
                value: 2,
            },
        ];

        let yaml = format_yaml(&data).unwrap();

        // Verify it's valid YAML
        let parsed: Vec<TestData> = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "foo");
        assert_eq!(parsed[1].name, "bar");
    }

    #[test]
    fn test_format_yaml_single_item() {
        let data = TestData {
            name: "test".into(),
            value: 20,
        };
        let yaml = format_yaml(&data).unwrap();

        assert!(yaml.contains("test"));
        assert!(yaml.contains("20"));

        let parsed: TestData = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(parsed.name, "test");
        assert_eq!(parsed.value, 20);
    }

    #[test]
    fn test_format_empty_vec() {
        let data: Vec<TestData> = vec![];

        let json = format_json(&data).unwrap();
        assert_eq!(json, "[]");

        let yaml = format_yaml(&data).unwrap();
        let parsed: Vec<TestData> = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(parsed.len(), 0);
    }

    #[test]
    fn test_print_output_writer() {
        let data = TestData {
            name: "writer_test".into(),
            value: 123,
        };
        let mut buffer = Vec::new();

        print_output(&mut buffer, &data, OutputFormat::Json, |_, _| Ok(())).unwrap();

        let output = String::from_utf8(buffer).unwrap();
        assert!(output.contains("writer_test"));
        assert!(output.contains("123"));
    }

    fn render_gtmpl(json: &serde_json::Value, template: &str) -> String {
        let ctx = value_from_serde_json(json);
        GtmplWithJson::parse(template).unwrap().render(ctx).unwrap()
    }

    #[test]
    fn test_value_from_serde_json_string() {
        let json = serde_json::json!({"s": "hello"});
        assert_eq!(render_gtmpl(&json, "{{.s}}"), "hello");
    }

    #[test]
    fn test_value_from_serde_json_number_int() {
        let json = serde_json::json!({"n": 42});
        assert_eq!(render_gtmpl(&json, "{{.n}}"), "42");
    }

    #[test]
    fn test_value_from_serde_json_number_float() {
        let json = serde_json::json!({"f": 1.5});
        let out = render_gtmpl(&json, "{{.f}}");
        assert!(
            out.starts_with("1.5") || out == "1.5",
            "expected 1.5, got {}",
            out
        );
    }

    #[test]
    fn test_value_from_serde_json_bool() {
        let json = serde_json::json!({"b": true});
        assert_eq!(render_gtmpl(&json, "{{.b}}"), "true");
    }

    #[test]
    fn test_value_from_serde_json_null() {
        let json = serde_json::json!({"n": null});
        assert_eq!(render_gtmpl(&json, "{{.n}}"), "");
    }

    #[test]
    fn test_value_from_serde_json_object() {
        let json = serde_json::json!({"id": "abc", "cpus": 2});
        assert_eq!(render_gtmpl(&json, "{{.id}}"), "abc");
        assert_eq!(render_gtmpl(&json, "{{.cpus}}"), "2");
    }

    #[test]
    fn test_value_from_serde_json_nested_object() {
        let json = serde_json::json!({"state": {"status": "running", "pid": 12345}});
        assert_eq!(render_gtmpl(&json, "{{.state.status}}"), "running");
        assert_eq!(render_gtmpl(&json, "{{.state.pid}}"), "12345");
    }

    #[test]
    fn test_value_from_serde_json_array() {
        let json = serde_json::json!([10, 20, 30]);
        // gtmpl index: (index slice index)
        assert_eq!(render_gtmpl(&json, "{{index . 0}}"), "10");
        assert_eq!(render_gtmpl(&json, "{{index . 1}}"), "20");
        assert_eq!(render_gtmpl(&json, "{{index . 2}}"), "30");
    }
}
