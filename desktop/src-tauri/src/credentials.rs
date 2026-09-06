use uuid::Uuid;

use crate::error::{DesktopError, Result};

const SERVICE: &str = "cloud.xuchen.penpot.desktop";
const SECRET_NAMES: [&str; 5] = [
    "database-password",
    "cache-password",
    "penpot-secret",
    "media-processor-key",
    "management-key",
];

pub struct StoredSecrets {
    pub database_password: String,
    pub cache_password: String,
    pub penpot_secret: String,
    pub media_processor_key: String,
    pub management_key: String,
}

pub trait CredentialStore {
    fn get(&self, name: &str) -> Result<Option<String>>;
    fn set(&self, name: &str, value: &str) -> Result<()>;

    fn load_or_create(&self) -> Result<StoredSecrets> {
        let mut values = Vec::with_capacity(SECRET_NAMES.len());
        for name in SECRET_NAMES {
            match self.get(name)? {
                Some(value) if !value.is_empty() => values.push(value),
                _ => {
                    let value = random_secret();
                    self.set(name, &value)?;
                    values.push(value);
                }
            }
        }
        let mut values = values.into_iter();
        Ok(StoredSecrets {
            database_password: values.next().expect("all secret names were loaded"),
            cache_password: values.next().expect("all secret names were loaded"),
            penpot_secret: values.next().expect("all secret names were loaded"),
            media_processor_key: values.next().expect("all secret names were loaded"),
            management_key: values.next().expect("all secret names were loaded"),
        })
    }
}

pub struct SystemCredentialStore {
    installation_id: Uuid,
}

impl SystemCredentialStore {
    pub fn new(installation_id: Uuid) -> Self {
        Self { installation_id }
    }

    fn entry(&self, name: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, &format!("{}/{name}", self.installation_id))
            .map_err(|error| DesktopError::Credential(error.to_string()))
    }

    pub fn verify_roundtrip(&self) -> Result<()> {
        let name = format!("compatibility-{}", Uuid::new_v4().simple());
        let value = random_secret();
        let entry = self.entry(&name)?;
        entry
            .set_password(&value)
            .map_err(|error| DesktopError::Credential(error.to_string()))?;
        let loaded = entry
            .get_password()
            .map_err(|error| DesktopError::Credential(error.to_string()));
        let deleted = entry
            .delete_credential()
            .map_err(|error| DesktopError::Credential(error.to_string()));
        let loaded = loaded?;
        deleted?;
        if loaded != value {
            return Err(DesktopError::Credential(
                "credential manager roundtrip returned a different value".to_owned(),
            ));
        }
        Ok(())
    }
}

impl CredentialStore for SystemCredentialStore {
    fn get(&self, name: &str) -> Result<Option<String>> {
        match self.entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(DesktopError::Credential(error.to_string())),
        }
    }

    fn set(&self, name: &str, value: &str) -> Result<()> {
        self.entry(name)?
            .set_password(value)
            .map_err(|error| DesktopError::Credential(error.to_string()))
    }
}

fn random_secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryStore {
        fn get(&self, name: &str) -> Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }

        fn set(&self, name: &str, value: &str) -> Result<()> {
            self.0
                .lock()
                .unwrap()
                .insert(name.to_owned(), value.to_owned());
            Ok(())
        }
    }

    #[test]
    fn creates_each_secret_once_and_reuses_it() {
        let store = MemoryStore::default();
        let first = store.load_or_create().unwrap();
        let second = store.load_or_create().unwrap();

        assert_eq!(first.database_password, second.database_password);
        assert_eq!(first.management_key, second.management_key);
        assert_ne!(first.database_password, first.cache_password);
        assert!(first.penpot_secret.len() >= 64);
        assert_eq!(store.0.lock().unwrap().len(), SECRET_NAMES.len());
    }

    #[test]
    fn replaces_an_empty_credential() {
        let store = MemoryStore::default();
        store.set("database-password", "").unwrap();

        let secrets = store.load_or_create().unwrap();

        assert!(!secrets.database_password.is_empty());
    }
}
