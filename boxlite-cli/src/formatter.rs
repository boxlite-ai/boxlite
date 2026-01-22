// Output formatting utilities for CLI commands.
// Provides unified formatting for different output formats (table, JSON, YAML).

use anyhow::{Result, anyhow};
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
}
