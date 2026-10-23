//! Crate docs. fn fake() {}
use std::collections::{HashMap, HashSet as Set};
use std::fmt::{self, Display};
use crate::config::*;
use serde::Serialize;
mod config;
extern crate alloc;

/* block /* nested */ comment fn hidden() {} */
pub const MAX: usize = 10;
static mut COUNTER: u32 = 0;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Serialize)]
pub struct Store<'a> {
    pub name: &'a str,
    items: HashMap<String, Vec<u8>>,
    pub(crate) limit: usize,
}

pub enum Error {
    NotFound,
    Invalid(String),
    Other { code: i32 },
}

pub trait Backend: Display + Send {
    fn get(&self, key: &str) -> Option<String>;
    fn put(&mut self, key: &str, value: String) {
        self.validate(key);
    }
    fn validate(&self, key: &str);
}

impl<'a> Store<'a> {
    pub fn new(name: &'a str) -> Self {
        let c = 'x';
        let s = "fn fake() {";
        let r = r#"raw "quoted" fn raw() {}"#;
        Store { name, items: HashMap::new(), limit: MAX }
    }

    pub fn len(&self) -> usize {
        self.items.len() + Self::helper()
    }

    fn helper() -> usize {
        0
    }
}

impl<'a> Display for Store<'a> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", self.name)
    }
}

impl Backend for Cache {
    fn get(&self, key: &str) -> Option<String> {
        None
    }
    fn validate(&self, _key: &str) {}
}

pub async fn run(store: Store<'_>) -> Result<()> {
    let n = store.len();
    build(n);
    Ok(())
}

fn build(n: usize) -> Store<'static> {
    Store::new("x")
}
