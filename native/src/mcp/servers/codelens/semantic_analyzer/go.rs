use std::collections::HashSet;

use tree_sitter::Node;

use super::{field_name_text, is_valid_ident, make_def, DefKind, Definition};

pub fn builtins() -> HashSet<&'static str> {
    [
        // built-in functions
        "append",
        "cap",
        "clear",
        "close",
        "complex",
        "copy",
        "delete",
        "imag",
        "len",
        "make",
        "max",
        "min",
        "new",
        "panic",
        "print",
        "println",
        "real",
        "recover",
        // built-in types
        "bool",
        "byte",
        "complex64",
        "complex128",
        "error",
        "float32",
        "float64",
        "int",
        "int8",
        "int16",
        "int32",
        "int64",
        "rune",
        "string",
        "uint",
        "uint8",
        "uint16",
        "uint32",
        "uint64",
        "uintptr",
        "any",
        "comparable",
        // constants
        "true",
        "false",
        "iota",
        "nil",
        // common packages
        "fmt",
        "os",
        "io",
        "bufio",
        "bytes",
        "strings",
        "strconv",
        "math",
        "sort",
        "sync",
        "context",
        "errors",
        "log",
        "time",
        "net",
        "http",
        "json",
        "encoding",
        "crypto",
        "hash",
        "regexp",
        "flag",
        "path",
        "filepath",
        "reflect",
        "runtime",
        "testing",
        "unicode",
        "unicode",
        "container",
        "database",
        "debug",
        "embed",
        "expvar",
        "go",
        "image",
        "index",
        "mime",
        "plugin",
        "slices",
        "maps",
        "cmp",
        "iter",
        "structs",
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
        "function_declaration" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Function, s, e, depth))
        }
        "method_declaration" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Function, s, e, depth))
        }
        "type_declaration" => {
            // Contains type_spec children
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if child.kind() == "type_spec" {
                    let (name, s, e) = field_name_text(&child, source, "name")?;
                    return Some(make_def(name, DefKind::Type, s, e, depth));
                }
            }
            None
        }
        "var_declaration" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if child.kind() == "var_spec" {
                    let name_node = child.child_by_field_name("name")?;
                    let text = name_node.utf8_text(source.as_bytes()).ok()?.trim();
                    if !text.is_empty() {
                        return Some(make_def(
                            text,
                            DefKind::Variable,
                            name_node.start_byte() as u32,
                            name_node.end_byte() as u32,
                            depth,
                        ));
                    }
                }
            }
            None
        }
        "const_declaration" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if child.kind() == "const_spec" {
                    let name_node = child.child_by_field_name("name")?;
                    let text = name_node.utf8_text(source.as_bytes()).ok()?.trim();
                    if !text.is_empty() {
                        return Some(make_def(
                            text,
                            DefKind::Constant,
                            name_node.start_byte() as u32,
                            name_node.end_byte() as u32,
                            depth,
                        ));
                    }
                }
            }
            None
        }
        "short_var_declaration" => {
            // `x := ...`
            let left = node.child_by_field_name("left")?;
            if left.kind() == "identifier" {
                let text = left.utf8_text(source.as_bytes()).ok()?.trim();
                if !text.is_empty() {
                    return Some(make_def(
                        text,
                        DefKind::Variable,
                        left.start_byte() as u32,
                        left.end_byte() as u32,
                        depth,
                    ));
                }
            }
            // expression_list with multiple identifiers
            if left.kind() == "expression_list" {
                let mut cursor = left.walk();
                for child in left.named_children(&mut cursor) {
                    if child.kind() == "identifier" {
                        let text = child.utf8_text(source.as_bytes()).ok()?.trim();
                        if !text.is_empty() {
                            return Some(make_def(
                                text,
                                DefKind::Variable,
                                child.start_byte() as u32,
                                child.end_byte() as u32,
                                depth,
                            ));
                        }
                    }
                }
            }
            None
        }
        "parameter_declaration" => {
            let name_node = node.child_by_field_name("name")?;
            let text = name_node.utf8_text(source.as_bytes()).ok()?.trim();
            if !text.is_empty() {
                return Some(make_def(
                    text,
                    DefKind::Parameter,
                    name_node.start_byte() as u32,
                    name_node.end_byte() as u32,
                    depth,
                ));
            }
            None
        }
        "import_declaration" => {
            // Record the last path segment or alias
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if child.kind() == "import_spec" {
                    let name_node = child
                        .child_by_field_name("name")
                        .or_else(|| child.child_by_field_name("path"));
                    if let Some(nn) = name_node {
                        let text = nn.utf8_text(source.as_bytes()).ok()?.trim();
                        let simple = text.trim_matches('"').rsplit('/').next().unwrap_or(text);
                        if !simple.is_empty() && is_valid_ident(simple) {
                            return Some(make_def(
                                simple,
                                DefKind::Import,
                                nn.start_byte() as u32,
                                nn.end_byte() as u32,
                                depth,
                            ));
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}
