use std::collections::HashSet;

use tree_sitter::Node;

use super::{field_name_text, is_valid_ident, make_def, DefKind, Definition};

pub fn builtins() -> HashSet<&'static str> {
    [
        // primitive types
        "boolean",
        "byte",
        "char",
        "short",
        "int",
        "long",
        "float",
        "double",
        "void",
        "var",
        // keywords that appear as identifiers
        "this",
        "super",
        "null",
        "true",
        "false",
        // java.lang
        "Object",
        "String",
        "Integer",
        "Long",
        "Double",
        "Float",
        "Boolean",
        "Byte",
        "Short",
        "Character",
        "Number",
        "Math",
        "System",
        "Runtime",
        "Thread",
        "Runnable",
        "Exception",
        "Error",
        "Throwable",
        "RuntimeException",
        "NullPointerException",
        "IllegalArgumentException",
        "IllegalStateException",
        "IndexOutOfBoundsException",
        "ArrayIndexOutOfBoundsException",
        "StringIndexOutOfBoundsException",
        "ClassCastException",
        "ArithmeticException",
        "NumberFormatException",
        "UnsupportedOperationException",
        "ConcurrentModificationException",
        "ClassNotFoundException",
        "NoClassDefFoundError",
        "StringBuilder",
        "StringBuffer",
        "Comparable",
        "Iterable",
        "Cloneable",
        "AutoCloseable",
        "Override",
        "Deprecated",
        "SuppressWarnings",
        "FunctionalInterface",
        "SafeVarargs",
        "Class",
        "ClassLoader",
        "Process",
        "ProcessBuilder",
        "Package",
        "Enum",
        "Record",
        "Void",
        "StrictMath",
        "Compiler",
        "InheritableThreadLocal",
        "ThreadLocal",
        "ThreadGroup",
        "SecurityManager",
        // common java.util
        "List",
        "ArrayList",
        "LinkedList",
        "Map",
        "HashMap",
        "TreeMap",
        "LinkedHashMap",
        "Set",
        "HashSet",
        "TreeSet",
        "LinkedHashSet",
        "Queue",
        "Deque",
        "ArrayDeque",
        "PriorityQueue",
        "Collection",
        "Collections",
        "Arrays",
        "Iterator",
        "Optional",
        "Stream",
        "Comparator",
        "Date",
        "Calendar",
        "UUID",
        "Objects",
        // common java.io
        "File",
        "InputStream",
        "OutputStream",
        "Reader",
        "Writer",
        "BufferedReader",
        "BufferedWriter",
        "PrintWriter",
        "Scanner",
        "IOException",
        "FileNotFoundException",
        // annotations
        "Override",
        "Deprecated",
        "SuppressWarnings",
        "FunctionalInterface",
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
        "method_declaration" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Function, s, e, depth))
        }
        "class_declaration" | "enum_declaration" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Class, s, e, depth))
        }
        "interface_declaration" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Type, s, e, depth))
        }
        "local_variable_declaration" | "field_declaration" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if child.kind() == "variable_declarator" {
                    let (name, s, e) = field_name_text(&child, source, "name")?;
                    return Some(make_def(name, DefKind::Variable, s, e, depth));
                }
            }
            None
        }
        "formal_parameter" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Parameter, s, e, depth))
        }
        "import_declaration" => {
            // Record the last segment
            let text = node.utf8_text(source.as_bytes()).ok()?.trim();
            let simple = text
                .trim_start_matches("import")
                .trim_start_matches("static")
                .trim()
                .trim_end_matches(';')
                .rsplit('.')
                .next()
                .unwrap_or("")
                .trim();
            if !simple.is_empty() && is_valid_ident(simple) && simple != "*" {
                return Some(make_def(
                    simple,
                    DefKind::Import,
                    node.start_byte() as u32,
                    node.end_byte() as u32,
                    depth,
                ));
            }
            None
        }
        _ => None,
    }
}
