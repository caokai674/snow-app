use std::collections::HashSet;

use tree_sitter::Node;

use super::{field_name_text, make_def, DefKind, Definition};

pub fn builtins() -> HashSet<&'static str> {
    [
        // types
        "void",
        "char",
        "short",
        "int",
        "long",
        "float",
        "double",
        "signed",
        "unsigned",
        "size_t",
        "ssize_t",
        "ptrdiff_t",
        "int8_t",
        "int16_t",
        "int32_t",
        "int64_t",
        "uint8_t",
        "uint16_t",
        "uint32_t",
        "uint64_t",
        "intptr_t",
        "uintptr_t",
        "wchar_t",
        "bool",
        // stdio
        "printf",
        "fprintf",
        "sprintf",
        "snprintf",
        "scanf",
        "fscanf",
        "sscanf",
        "fopen",
        "fclose",
        "fread",
        "fwrite",
        "fseek",
        "ftell",
        "fflush",
        "fgets",
        "fputs",
        "getchar",
        "putchar",
        "puts",
        "gets",
        "perror",
        "FILE",
        "stdin",
        "stdout",
        "stderr",
        "EOF",
        // stdlib
        "malloc",
        "calloc",
        "realloc",
        "free",
        "abort",
        "exit",
        "atexit",
        "atoi",
        "atol",
        "atof",
        "strtol",
        "strtoul",
        "strtod",
        "abs",
        "labs",
        "div",
        "ldiv",
        "qsort",
        "bsearch",
        "rand",
        "srand",
        "RAND_MAX",
        // string
        "strlen",
        "strcpy",
        "strncpy",
        "strcat",
        "strncat",
        "strcmp",
        "strncmp",
        "strchr",
        "strrchr",
        "strstr",
        "strtok",
        "memcpy",
        "memmove",
        "memset",
        "memcmp",
        "strdup",
        "strndup",
        // constants
        "NULL",
        "true",
        "false",
        "EXIT_SUCCESS",
        "EXIT_FAILURE",
        // common
        "main",
        "argc",
        "argv",
        "const",
        "static",
        "extern",
        "register",
        "volatile",
        "inline",
        "restrict",
        "typedef",
        "struct",
        "union",
        "enum",
        "sizeof",
        "return",
        "if",
        "else",
        "for",
        "while",
        "do",
        "switch",
        "case",
        "default",
        "break",
        "continue",
        "goto",
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
        "function_definition" => {
            // declarator -> function_declarator -> declarator -> identifier
            let decl = node.child_by_field_name("declarator")?;
            let ident = find_nested_identifier(&decl, source)?;
            Some(make_def(
                ident.0,
                DefKind::Function,
                ident.1,
                ident.2,
                depth,
            ))
        }
        "struct_specifier" | "enum_specifier" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Type, s, e, depth))
        }
        "type_definition" => {
            let decl = node.child_by_field_name("declarator")?;
            let ident = find_nested_identifier(&decl, source)?;
            Some(make_def(ident.0, DefKind::Type, ident.1, ident.2, depth))
        }
        "init_declarator" => {
            let decl = node.child_by_field_name("declarator")?;
            let ident = find_nested_identifier(&decl, source)?;
            Some(make_def(
                ident.0,
                DefKind::Variable,
                ident.1,
                ident.2,
                depth,
            ))
        }
        "parameter_declaration" => {
            let decl = node.child_by_field_name("declarator")?;
            let ident = find_nested_identifier(&decl, source)?;
            Some(make_def(
                ident.0,
                DefKind::Parameter,
                ident.1,
                ident.2,
                depth,
            ))
        }
        _ => None,
    }
}

/// Walk down a declarator tree to find the innermost identifier.
fn find_nested_identifier<'a>(node: &Node, source: &'a str) -> Option<(&'a str, u32, u32)> {
    if node.kind() == "identifier" || node.kind() == "field_identifier" {
        let text = node.utf8_text(source.as_bytes()).ok()?.trim();
        if !text.is_empty() {
            return Some((text, node.start_byte() as u32, node.end_byte() as u32));
        }
        return None;
    }
    // Recurse into the `declarator` field if present
    if let Some(child) = node.child_by_field_name("declarator") {
        return find_nested_identifier(&child, source);
    }
    // Fallback: first named child
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if let Some(result) = find_nested_identifier(&child, source) {
            return Some(result);
        }
    }
    None
}
