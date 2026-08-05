use std::collections::HashSet;

use tree_sitter::Node;

use super::{field_name_text, make_def, DefKind, Definition};

pub fn builtins() -> HashSet<&'static str> {
    [
        // basic functions
        "assert",
        "collectgarbage",
        "dofile",
        "error",
        "getmetatable",
        "ipairs",
        "load",
        "loadfile",
        "next",
        "pairs",
        "pcall",
        "print",
        "rawequal",
        "rawget",
        "rawlen",
        "rawset",
        "require",
        "select",
        "setmetatable",
        "tonumber",
        "tostring",
        "type",
        "warn",
        "xpcall",
        // constants
        "nil",
        "true",
        "false",
        "_G",
        "_VERSION",
        "_ENV",
        // libraries
        "coroutine",
        "debug",
        "io",
        "math",
        "os",
        "package",
        "string",
        "table",
        "utf8",
        // string lib
        "byte",
        "char",
        "dump",
        "find",
        "format",
        "gmatch",
        "gsub",
        "len",
        "lower",
        "match",
        "rep",
        "reverse",
        "sub",
        "upper",
        // table lib
        "concat",
        "insert",
        "move",
        "pack",
        "remove",
        "sort",
        "unpack",
        // math lib
        "abs",
        "acos",
        "asin",
        "atan",
        "ceil",
        "cos",
        "deg",
        "exp",
        "floor",
        "fmod",
        "huge",
        "log",
        "max",
        "maxinteger",
        "min",
        "mininteger",
        "modf",
        "pi",
        "rad",
        "random",
        "randomseed",
        "sin",
        "sqrt",
        "tan",
        "tointeger",
        "type",
        "ult",
        // io lib
        "close",
        "flush",
        "input",
        "lines",
        "open",
        "output",
        "popen",
        "read",
        "tmpfile",
        "write",
        "stdin",
        "stdout",
        "stderr",
        // os lib
        "clock",
        "date",
        "difftime",
        "execute",
        "exit",
        "getenv",
        "remove",
        "rename",
        "setlocale",
        "time",
        "tmpname",
        // coroutine lib
        "create",
        "isyieldable",
        "resume",
        "running",
        "status",
        "wrap",
        "yield",
        "close",
        // debug lib
        "getinfo",
        "getlocal",
        "getupvalue",
        "getuservalue",
        "sethook",
        "setlocal",
        "setupvalue",
        "setuservalue",
        "traceback",
        "upvalueid",
        "upvaluejoin",
        // utf8 lib
        "char",
        "charpattern",
        "codepoint",
        "codes",
        "len",
        "offset",
        // package lib
        "config",
        "cpath",
        "loaded",
        "loadlib",
        "path",
        "preload",
        "searchers",
        "searchpath",
        // self
        "self",
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
            // Handle dotted names like `a.b.c` -- take the first segment
            let simple = name.split('.').next().unwrap_or(name);
            Some(make_def(simple, DefKind::Function, s, e, depth))
        }
        "assignment_statement" => {
            // Left side: variable_list
            let left = node.child_by_field_name("left").or_else(|| {
                // Some grammars use the first named child
                let mut c = node.walk();
                let first = node.named_children(&mut c).next();
                first
            })?;
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
            None
        }
        "local_variable_declaration" => {
            // names: variable_list -> identifier
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
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
                if child.kind() == "variable_list" {
                    let mut c2 = child.walk();
                    for gc in child.named_children(&mut c2) {
                        if gc.kind() == "identifier" {
                            let text = gc.utf8_text(source.as_bytes()).ok()?.trim();
                            if !text.is_empty() {
                                return Some(make_def(
                                    text,
                                    DefKind::Variable,
                                    gc.start_byte() as u32,
                                    gc.end_byte() as u32,
                                    depth,
                                ));
                            }
                        }
                    }
                }
            }
            None
        }
        "parameters" => {
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
        "for_statement" | "for_numeric_loop" | "for_generic_loop" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
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
            None
        }
        _ => None,
    }
}
