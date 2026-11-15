//! Lossless wallet protocol units. Old small JSON integers remain accepted.
use serde::{de, Deserialize, Deserializer, Serializer};
#[derive(Deserialize)]
#[serde(untagged)]
enum Units {
    Text(String),
    Integer(u64),
}
pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    match Units::deserialize(d)? {
        Units::Integer(n) if n <= 9_007_199_254_740_991 => Ok(n),
        Units::Integer(_) => Err(de::Error::custom("large units require a decimal string")),
        Units::Text(s) => {
            let n: u64 = s.parse().map_err(de::Error::custom)?;
            if n.to_string() != s {
                return Err(de::Error::custom("canonical decimal string required"));
            }
            Ok(n)
        }
    }
}
pub fn serialize<S: Serializer>(n: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&n.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Deserialize, serde::Serialize)]
    struct Example {
        #[serde(deserialize_with = "deserialize", serialize_with = "serialize")]
        amount: u64,
    }
    #[test]
    fn precision_is_never_lost_at_the_json_boundary() {
        for input in [
            r#"{"amount":"9007199254740993"}"#,
            r#"{"amount":"9223372036854775807"}"#,
            r#"{"amount":"18446744073709551615"}"#,
        ] {
            let value: Example = serde_json::from_str(input).unwrap();
            assert_eq!(serde_json::to_string(&value).unwrap(), input);
        }
        assert_eq!(
            serde_json::from_str::<Example>(r#"{"amount":26}"#)
                .unwrap()
                .amount,
            26
        );
        for input in [
            r#"{"amount":9007199254740993}"#,
            r#"{"amount":"01"}"#,
            r#"{"amount":"-1"}"#,
            r#"{"amount":"1e6"}"#,
            r#"{"amount":1.5}"#,
        ] {
            assert!(serde_json::from_str::<Example>(input).is_err());
        }
    }
}
