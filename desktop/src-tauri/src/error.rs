use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum DesktopError {
    #[error("could not determine the application data directory")]
    MissingDataDirectory,

    #[error("could not read {path}: {source}")]
    ReadFile {
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("could not write {path}: {source}")]
    WriteFile {
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("invalid JSON in {path}: {source}")]
    InvalidJson {
        path: PathBuf,
        source: serde_json::Error,
    },

    #[error("invalid desktop configuration: {0}")]
    InvalidConfig(String),

    #[error("invalid runtime manifest: {0}")]
    InvalidManifest(String),

    #[error("runtime bundle is incomplete: {0}")]
    MissingRuntime(String),

    #[error("runtime integrity check failed: {0}")]
    RuntimeIntegrity(String),

    #[error("credential store error: {0}")]
    Credential(String),

    #[error("gateway error: {0}")]
    Gateway(String),

    #[error("runtime process error: {0}")]
    Process(String),

    #[error("compatibility gate error: {0}")]
    Compatibility(String),
}

impl serde::Serialize for DesktopError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, DesktopError>;
