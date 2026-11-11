//! CPU resource quantities normalized to integer millicpu.

use boxlite_shared::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize, Serializer};

/// Validated CPU allocation. Only fractional allocations enable bandwidth limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CpuCount(u32);

impl CpuCount {
    pub fn new(cores: f64) -> BoxliteResult<Self> {
        if !cores.is_finite() || !(0.125..=255.0).contains(&cores) {
            return Err(BoxliteError::InvalidArgument(
                "cpus must be finite and between 0.125 and 255".into(),
            ));
        }
        let millicpu = (cores * 1000.0).round() as u32;
        if f64::from(millicpu) / 1000.0 != cores {
            return Err(BoxliteError::InvalidArgument(
                "cpus must be a multiple of 0.001 cores".into(),
            ));
        }
        Ok(Self(millicpu))
    }

    pub fn cores(self) -> f64 {
        f64::from(self.0) / 1000.0
    }
    pub fn is_fractional(self) -> bool {
        !self.0.is_multiple_of(1000)
    }
    pub fn vcpus(self) -> u8 {
        self.0.div_ceil(1000) as u8
    }
    #[cfg(target_os = "linux")]
    pub(crate) fn millicpu(self) -> u32 {
        self.0
    }
}

/// Keep integer CPU JSON compatible with servers whose schemas require integers.
pub fn serialize<S: Serializer>(cores: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if cores.fract() == 0.0 && (0.0..=255.0).contains(cores) {
        serializer.serialize_u64(*cores as u64)
    } else {
        serializer.serialize_f64(*cores)
    }
}

pub fn serialize_optional<S: Serializer>(
    cores: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match cores {
        Some(cores) => serialize(cores, serializer),
        None => serializer.serialize_none(),
    }
}

impl Serialize for CpuCount {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serialize(&self.cores(), serializer)
    }
}

/// Refuse experimental limits without rejecting unrelated legacy option fields.
pub(crate) fn deserialize_options<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    for field in ["cpu_limit", "cpu_limit_millicpu"] {
        if value.get(field).is_some_and(|limit| !limit.is_null()) {
            return Err(serde::de::Error::custom(format!(
                "unsupported experimental {field} configuration; recreate the box with cpus"
            )));
        }
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BoxOptions;

    #[test]
    fn fractional_cpus_normalize_and_derive_topology() {
        for (cores, vcpus, fractional) in [
            (0.126, 1, true),
            (0.125, 1, true),
            (0.5, 1, true),
            (1.0, 1, false),
            (1.001, 2, true),
            (1.5, 2, true),
            (2.0, 2, false),
            (255.0, 255, false),
        ] {
            let cpu = CpuCount::new(cores).unwrap();
            assert_eq!(
                (cpu.cores(), cpu.vcpus(), cpu.is_fractional()),
                (cores, vcpus, fractional)
            );
            assert_eq!(serde_json::to_value(cpu).unwrap().as_f64(), Some(cores));
        }
        for cores in [
            0.0,
            -0.5,
            0.124,
            0.1251,
            1.0001,
            255.001,
            f64::NAN,
            f64::INFINITY,
        ] {
            assert!(CpuCount::new(cores).is_err(), "{cores}");
        }
        assert_eq!(
            serde_json::to_string(&CpuCount::new(2.0).unwrap()).unwrap(),
            "2"
        );
    }

    #[test]
    fn fractional_cpus_options_serialization() {
        let mut options = BoxOptions {
            cpus: Some(1.5),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&options).unwrap()["cpus"],
            serde_json::json!(1.5)
        );
        options.cpus = Some(2.0);
        options.sanitize_common().unwrap();
        assert_eq!(
            serde_json::to_value(&options).unwrap()["cpus"],
            serde_json::json!(2)
        );
        options.cpus = None;
        options.sanitize_common().unwrap();
    }
}
