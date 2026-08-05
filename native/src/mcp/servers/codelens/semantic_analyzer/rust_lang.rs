use std::collections::HashSet;

use tree_sitter::Node;

use super::{field_name_text, is_valid_ident, make_def, DefKind, Definition};

pub fn builtins() -> HashSet<&'static str> {
    [
        // primitive types
        "bool",
        "char",
        "f32",
        "f64",
        "i8",
        "i16",
        "i32",
        "i64",
        "i128",
        "isize",
        "str",
        "u8",
        "u16",
        "u32",
        "u64",
        "u128",
        "usize",
        // core types
        "String",
        "Vec",
        "Box",
        "Rc",
        "Arc",
        "Cell",
        "RefCell",
        "Mutex",
        "RwLock",
        "Option",
        "Result",
        "Ok",
        "Err",
        "Some",
        "None",
        "HashMap",
        "HashSet",
        "BTreeMap",
        "BTreeSet",
        "VecDeque",
        "LinkedList",
        "BinaryHeap",
        "PhantomData",
        "Cow",
        "Pin",
        // traits
        "Copy",
        "Clone",
        "Debug",
        "Default",
        "Drop",
        "Eq",
        "Hash",
        "Ord",
        "PartialEq",
        "PartialOrd",
        "Send",
        "Sync",
        "Sized",
        "Unpin",
        "Fn",
        "FnMut",
        "FnOnce",
        "Iterator",
        "IntoIterator",
        "From",
        "Into",
        "TryFrom",
        "TryInto",
        "AsRef",
        "AsMut",
        "Deref",
        "DerefMut",
        "Borrow",
        "BorrowMut",
        "ToOwned",
        "ToString",
        "Display",
        "Write",
        "Read",
        "Seek",
        "BufRead",
        "Error",
        "Future",
        "Stream",
        "Extend",
        "FromIterator",
        "DoubleEndedIterator",
        "ExactSizeIterator",
        "FusedIterator",
        "Index",
        "IndexMut",
        "RangeBounds",
        "Step",
        // macros
        "println",
        "eprintln",
        "print",
        "eprint",
        "format",
        "write",
        "writeln",
        "vec",
        "assert",
        "assert_eq",
        "assert_ne",
        "debug_assert",
        "debug_assert_eq",
        "debug_assert_ne",
        "panic",
        "todo",
        "unimplemented",
        "unreachable",
        "cfg",
        "include",
        "include_str",
        "include_bytes",
        "env",
        "option_env",
        "compile_error",
        "concat",
        "stringify",
        "line",
        "column",
        "file",
        "module_path",
        "matches",
        "const_format",
        // keywords that look like identifiers
        "self",
        "Self",
        "super",
        "crate",
        // common std items
        "std",
        "core",
        "alloc",
        "main",
        "Box",
        "ToOwned",
        "Clone",
        "Clone",
        // common derive helpers
        "Serialize",
        "Deserialize",
        // common crate names (may appear as bare idents in macros)
        "napi",
        "serde",
        "serde_json",
        "rusqlite",
        "tokio",
        "blake3",
        "reqwest",
        "uuid",
        "chrono",
        "regex",
        "log",
        "anyhow",
        "thiserror",
        "tracing",
        "futures",
        "async_trait",
        // common napi / serde types
        "Status",
        "Value",
        "Number",
        "Map",
        "Array",
        "Boolean",
        "Undefined",
        "Null",
        "Object",
        "Function",
        "Promise",
        "Env",
        "CallbackInfo",
        "JsUndefined",
        "JsNull",
        "JsBoolean",
        "JsNumber",
        "JsString",
        "JsObject",
        "JsArray",
        "JsFunction",
        "JsUnknown",
        "JsError",
        "Either",
        "Task",
        "AsyncTask",
        "Connection",
        "OptionalExtension",
        "Params",
        "Statement",
        // common attribute / derive names
        "derive",
        "cfg",
        "allow",
        "warn",
        "deny",
        "forbid",
        "deprecated",
        "must_use",
        "repr",
        "inline",
        "test",
        "non_exhaustive",
        "cold",
        "target_feature",
        // common trait method names that may appear as bare idents
        "new",
        "default",
        "from",
        "into",
        "try_from",
        "try_into",
        "as_ref",
        "as_mut",
        "to_string",
        "to_owned",
        "clone",
        "fmt",
        "hash",
        "eq",
        "cmp",
        "next",
        "len",
        "is_empty",
        "iter",
        "push",
        "pop",
        "insert",
        "remove",
        "contains",
        "get",
        "unwrap",
        "expect",
        "map",
        "and_then",
        "or_else",
        "ok_or",
        "ok_or_else",
        "unwrap_or",
        "unwrap_or_else",
        "is_some",
        "is_none",
        "is_ok",
        "is_err",
        "collect",
        "filter",
        "find",
        "any",
        "all",
        "count",
        "fold",
        "enumerate",
        "zip",
        "chain",
        "take",
        "skip",
        "rev",
        "sort",
        "sort_by",
        "split",
        "join",
        "replace",
        "trim",
        "parse",
        "format",
        "write",
        "read",
        "flush",
        "seek",
        "spawn",
        "spawn_blocking",
        "block_on",
        "await",
        "run",
        "execute",
        "query",
        "query_row",
        "prepare",
        "open",
        "create",
        "close",
        "send",
        "recv",
        "poll",
        "encode",
        "decode",
        "serialize",
        "deserialize",
        "to_hex",
        "as_bytes",
        "as_str",
        "to_vec",
        "to_owned",
        "starts_with",
        "ends_with",
        "chars",
        "bytes",
        "lines",
        "strip_prefix",
        "strip_suffix",
        "repeat",
        "fill",
        "extend",
        "retain",
        "dedup",
        "reverse",
        "truncate",
        "resize",
        "swap",
        "clear",
        "drain",
        "position",
        "binary_search",
        "windows",
        "chunks",
        "flat_map",
        "for_each",
        "inspect",
        "peekable",
        "cycle",
        "min",
        "max",
        "sum",
        "product",
        "nth",
        "last",
        "copied",
        "cloned",
        "flatten",
        "unzip",
    ]
    .into_iter()
    .collect()
}

pub fn extract_definition(
    node: &Node,
    source: &str,
    kind: &str,
    depth: usize,
) -> Option<Definition> {
    match kind {
        "function_item" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Function, s, e, depth))
        }
        "struct_item" | "enum_item" | "trait_item" | "type_item" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Type, s, e, depth))
        }
        "mod_item" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Module, s, e, depth))
        }
        "const_item" | "static_item" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Constant, s, e, depth))
        }
        "macro_definition" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Function, s, e, depth))
        }
        "let_declaration" => {
            // `let x = ...` or `let (a, b) = ...`
            let pattern = node.child_by_field_name("pattern")?;
            extract_ident_from_pattern(&pattern, source, DefKind::Variable, depth)
        }
        "parameter" => {
            let pattern = node.child_by_field_name("pattern")?;
            extract_ident_from_pattern(&pattern, source, DefKind::Parameter, depth)
        }
        "use_declaration" => {
            // Simple path: `use foo::bar;` or `use bar;`
            // Grouped imports (`use foo::{A, B}`) and aliases (`use foo as bar`)
            // are handled when their child nodes (use_list / use_as_clause)
            // are visited by collect_definitions.
            let arg = node.child_by_field_name("argument")?;
            let ak = arg.kind();
            if ak == "scoped_identifier" || ak == "identifier" {
                let text = arg.utf8_text(source.as_bytes()).ok()?.trim();
                let simple = text.rsplit("::").next().unwrap_or(text).trim();
                if !simple.is_empty() && is_valid_ident(simple) && simple != "*" {
                    return Some(make_def(
                        simple,
                        DefKind::Import,
                        arg.start_byte() as u32,
                        arg.end_byte() as u32,
                        depth,
                    ));
                }
            }
            None
        }
        // `use foo::bar as baz;` -- record the alias
        "use_as_clause" => {
            let alias = node.child_by_field_name("alias")?;
            let text = alias.utf8_text(source.as_bytes()).ok()?.trim();
            if !text.is_empty() && is_valid_ident(text) {
                return Some(make_def(
                    text,
                    DefKind::Import,
                    alias.start_byte() as u32,
                    alias.end_byte() as u32,
                    depth,
                ));
            }
            None
        }
        // `use foo::{Bar, Baz};` -- each identifier child is an import
        "identifier" | "type_identifier" => {
            if let Some(parent) = node.parent() {
                if parent.kind() == "use_list" {
                    let text = node.utf8_text(source.as_bytes()).ok()?.trim();
                    if !text.is_empty() && is_valid_ident(text) {
                        return Some(make_def(
                            text,
                            DefKind::Import,
                            node.start_byte() as u32,
                            node.end_byte() as u32,
                            depth,
                        ));
                    }
                }
            }
            None
        }
        "closure_parameters" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if child.kind() == "identifier" {
                    let text = child.utf8_text(source.as_bytes()).ok()?.trim();
                    if !text.is_empty() {
                        return Some(make_def(
                            text,
                            DefKind::Parameter,
                            child.start_byte() as u32,
                            child.end_byte() as u32,
                            depth,
                        ));
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// Extract the first identifier from a pattern node (handles `x`, `mut x`, `ref x`).
fn extract_ident_from_pattern(
    pattern: &Node,
    source: &str,
    def_kind: DefKind,
    depth: usize,
) -> Option<Definition> {
    match pattern.kind() {
        "identifier" | "mutable_identifier" => {
            let text = pattern.utf8_text(source.as_bytes()).ok()?.trim();
            if !text.is_empty() {
                return Some(make_def(
                    text,
                    def_kind,
                    pattern.start_byte() as u32,
                    pattern.end_byte() as u32,
                    depth,
                ));
            }
            None
        }
        "tuple_pattern" | "tuple_struct_pattern" => {
            // Take the first identifier child
            let mut cursor = pattern.walk();
            for child in pattern.named_children(&mut cursor) {
                if let Some(def) = extract_ident_from_pattern(&child, source, def_kind, depth) {
                    return Some(def);
                }
            }
            None
        }
        _ => {
            // Fallback: look for an identifier child
            let mut cursor = pattern.walk();
            for child in pattern.named_children(&mut cursor) {
                if child.kind() == "identifier" {
                    let text = child.utf8_text(source.as_bytes()).ok()?.trim();
                    if !text.is_empty() {
                        return Some(make_def(
                            text,
                            def_kind,
                            child.start_byte() as u32,
                            child.end_byte() as u32,
                            depth,
                        ));
                    }
                }
            }
            None
        }
    }
}
