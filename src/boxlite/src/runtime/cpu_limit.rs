//! Creation-time CPU bandwidth, independent of the virtual CPU count.

use boxlite_shared::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};

/// Aggregate CPU time in cores, with millicore precision and a 0.01-core minimum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct CpuLimit(u32);

impl CpuLimit {
    /// Validate a core quantity without silently truncating fractional millicores.
    pub fn new(cores: f64) -> BoxliteResult<Self> {
        if !cores.is_finite() || !(0.01..=255.0).contains(&cores) {
            return Err(BoxliteError::InvalidArgument(
                "cpu_limit must be finite and between 0.01 and cpus".into(),
            ));
        }
        let millicpu = (cores * 1000.0).round() as u32;
        if f64::from(millicpu) / 1000.0 != cores {
            return Err(BoxliteError::InvalidArgument(
                "cpu_limit must be a multiple of 0.001 cores".into(),
            ));
        }
        Ok(Self(millicpu))
    }

    pub fn cores(self) -> f64 {
        f64::from(self.0) / 1000.0
    }

    pub(crate) fn millicpu(self) -> u32 {
        self.0
    }

    pub(crate) fn validate_cpus(self, cpus: u8) -> BoxliteResult<()> {
        if self.0 > u32::from(cpus) * 1000 {
            return Err(BoxliteError::InvalidArgument(
                "cpu_limit must not exceed cpus".into(),
            ));
        }
        Ok(())
    }
}

impl TryFrom<f64> for CpuLimit {
    type Error = BoxliteError;
    fn try_from(value: f64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<CpuLimit> for f64 {
    fn from(value: CpuLimit) -> Self {
        value.cores()
    }
}

impl std::fmt::Display for CpuLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cores().fmt(f)
    }
}

impl std::str::FromStr for CpuLimit {
    type Err = BoxliteError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value.parse().map_err(|_| {
            BoxliteError::InvalidArgument("cpu_limit must be a number of cores".into())
        })?)
    }
}

/// Immutable configuration stores integer millicpu; public wire types use cores.
pub(crate) mod persisted {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &Option<CpuLimit>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.map(CpuLimit::millicpu).serialize(s)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> Result<Option<CpuLimit>, D::Error> {
        Option::<u32>::deserialize(d)?
            .map(|value| CpuLimit::new(f64::from(value) / 1000.0).map_err(serde::de::Error::custom))
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BoxOptions;

    #[test]
    fn cpu_limit_validates_and_roundtrips() {
        for cores in [0.01, 0.011, 0.125, 0.5, 1.001, 2.0, 255.0] {
            let limit = CpuLimit::new(cores).unwrap();
            assert_eq!(limit.cores(), cores);
            assert_eq!(
                serde_json::from_str::<CpuLimit>(&serde_json::to_string(&limit).unwrap()).unwrap(),
                limit
            );
        }
        for cores in [
            0.0,
            -0.5,
            0.009,
            0.0101,
            1.0001,
            256.0,
            f64::NAN,
            f64::INFINITY,
        ] {
            assert!(CpuLimit::new(cores).is_err(), "{cores}");
        }
        assert!(CpuLimit::new(1.001).unwrap().validate_cpus(1).is_err());
        assert!(CpuLimit::new(2.0).unwrap().validate_cpus(2).is_ok());
    }

    #[test]
    fn cpu_limit_persistence_and_reuse() {
        let options = BoxOptions {
            cpus: Some(2),
            cpu_limit: Some(CpuLimit::new(0.125).unwrap()),
            ..Default::default()
        };
        let mut json = serde_json::to_value(&options).unwrap();
        assert_eq!(json["cpu_limit_millicpu"], 125);
        assert!(json.get("cpu_limit").is_none());
        let restored: BoxOptions = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(restored.cpu_limit, options.cpu_limit);
        assert!(options.check_reused_cpu_limit(restored.cpu_limit).is_ok());
        assert!(options.check_reused_cpu_limit(None).is_err());
        assert!(
            options
                .check_reused_cpu_limit(Some(CpuLimit::new(0.5).unwrap()))
                .is_err()
        );
        assert!(
            BoxOptions::default()
                .check_reused_cpu_limit(options.cpu_limit)
                .is_ok()
        );
        for value in [
            serde_json::Value::Null,
            serde_json::json!(0),
            serde_json::json!(125.5),
        ] {
            json["cpu_limit_millicpu"] = value.clone();
            let result = serde_json::from_value::<BoxOptions>(json.clone());
            assert_eq!(result.is_ok(), value.is_null());
        }
        json.as_object_mut().unwrap().remove("cpu_limit_millicpu");
        assert!(
            serde_json::from_value::<BoxOptions>(json)
                .unwrap()
                .cpu_limit
                .is_none()
        );
    }

    #[test]
    fn cpu_limit_checks_default_cpus_and_platform() {
        let default_cpus = crate::runtime::constants::vm_defaults::DEFAULT_CPUS;
        let mut options = BoxOptions {
            cpu_limit: Some(CpuLimit::new(f64::from(default_cpus)).unwrap()),
            ..Default::default()
        };
        options.validate_cpu_limit().unwrap();
        options.cpu_limit = Some(CpuLimit::new(f64::from(default_cpus) + 0.001).unwrap());
        assert!(options.validate_cpu_limit().is_err());
        options.cpu_limit = Some(CpuLimit::new(0.01).unwrap());
        if cfg!(target_os = "linux") {
            options.sanitize_common().unwrap();
        } else {
            assert!(matches!(
                options.sanitize_common(),
                Err(BoxliteError::Unsupported(_))
            ));
        }
        options.advanced.security.jailer_enabled = false;
        assert!(matches!(
            options.sanitize_common(),
            Err(BoxliteError::Unsupported(_))
        ));
        options.cpu_limit = None;
        options.sanitize_common().unwrap();
    }
}
