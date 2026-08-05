use std::collections::HashSet;

use tree_sitter::Node;

use super::{field_name_text, is_valid_ident, make_def, DefKind, Definition};

pub fn builtins() -> HashSet<&'static str> {
    [
        // built-in functions
        "print",
        "len",
        "range",
        "int",
        "str",
        "float",
        "bool",
        "list",
        "dict",
        "set",
        "tuple",
        "type",
        "isinstance",
        "issubclass",
        "hasattr",
        "getattr",
        "setattr",
        "delattr",
        "super",
        "property",
        "staticmethod",
        "classmethod",
        "enumerate",
        "zip",
        "map",
        "filter",
        "sorted",
        "reversed",
        "min",
        "max",
        "sum",
        "abs",
        "round",
        "pow",
        "divmod",
        "hash",
        "id",
        "repr",
        "format",
        "input",
        "open",
        "iter",
        "next",
        "all",
        "any",
        "bin",
        "oct",
        "hex",
        "chr",
        "ord",
        "callable",
        "compile",
        "eval",
        "exec",
        "globals",
        "locals",
        "vars",
        "dir",
        "help",
        "memoryview",
        "bytearray",
        "bytes",
        "frozenset",
        "complex",
        "object",
        "slice",
        "ascii",
        "breakpoint",
        "__import__",
        // built-in constants
        "True",
        "False",
        "None",
        "NotImplemented",
        "Ellipsis",
        "__debug__",
        // built-in exceptions
        "Exception",
        "BaseException",
        "ArithmeticError",
        "AssertionError",
        "AttributeError",
        "BlockingIOError",
        "BrokenPipeError",
        "BufferError",
        "BytesWarning",
        "ChildProcessError",
        "ConnectionAbortedError",
        "ConnectionError",
        "ConnectionRefusedError",
        "ConnectionResetError",
        "DeprecationWarning",
        "EOFError",
        "EnvironmentError",
        "FileExistsError",
        "FileNotFoundError",
        "FloatingPointError",
        "FutureWarning",
        "GeneratorExit",
        "IOError",
        "ImportError",
        "ImportWarning",
        "IndentationError",
        "IndexError",
        "InterruptedError",
        "IsADirectoryError",
        "KeyError",
        "KeyboardInterrupt",
        "LookupError",
        "MemoryError",
        "ModuleNotFoundError",
        "NameError",
        "NotADirectoryError",
        "NotImplementedError",
        "OSError",
        "OverflowError",
        "PendingDeprecationWarning",
        "PermissionError",
        "ProcessLookupError",
        "RecursionError",
        "ReferenceError",
        "ResourceWarning",
        "RuntimeError",
        "RuntimeWarning",
        "StopAsyncIteration",
        "StopIteration",
        "SyntaxError",
        "SyntaxWarning",
        "SystemError",
        "SystemExit",
        "TabError",
        "TimeoutError",
        "TypeError",
        "UnboundLocalError",
        "UnicodeDecodeError",
        "UnicodeEncodeError",
        "UnicodeError",
        "UnicodeTranslateError",
        "UnicodeWarning",
        "UserWarning",
        "ValueError",
        "Warning",
        "ZeroDivisionError",
        // typing / common
        "self",
        "cls",
        "__name__",
        "__file__",
        "__doc__",
        "__class__",
        "__init__",
        "__new__",
        "__del__",
        "__repr__",
        "__str__",
        // common stdlib modules used without import in scripts
        "os",
        "sys",
        "re",
        "json",
        "math",
        "datetime",
        "collections",
        "itertools",
        "functools",
        "pathlib",
        "typing",
        "abc",
        "io",
        "subprocess",
        "threading",
        "multiprocessing",
        "asyncio",
        "logging",
        "unittest",
        "pytest",
        "dataclasses",
        "enum",
        "copy",
        "string",
        "textwrap",
        "struct",
        "codecs",
        "csv",
        "sqlite3",
        "socket",
        "http",
        "urllib",
        "argparse",
        "configparser",
        "time",
        "random",
        "statistics",
        "decimal",
        "fractions",
        "numbers",
        "operator",
        "contextlib",
        "traceback",
        "warnings",
        "inspect",
        "importlib",
        "pickle",
        "shelve",
        "marshal",
        "dbm",
        "gzip",
        "bz2",
        "lzma",
        "zipfile",
        "tarfile",
        "tempfile",
        "shutil",
        "glob",
        "fnmatch",
        "stat",
        "fileinput",
        "hashlib",
        "hmac",
        "secrets",
        "base64",
        "binascii",
        "difflib",
        "pprint",
        "uuid",
        "platform",
        "errno",
        "signal",
        "mmap",
        "ctypes",
        "array",
        "weakref",
        "types",
        "atexit",
        "gc",
        "select",
        "selectors",
        "queue",
        "sched",
        "_thread",
        "concurrent",
        "email",
        "html",
        "xml",
        "webbrowser",
        "cgi",
        "wsgiref",
        "xmlrpc",
        "ftplib",
        "poplib",
        "imaplib",
        "smtplib",
        "mailbox",
        "mimetypes",
        "encodings",
        "gettext",
        "locale",
        "calendar",
        "cmd",
        "shlex",
        "tkinter",
        "turtle",
        "curses",
        "readline",
        "rlcompleter",
        "pdb",
        "profile",
        "timeit",
        "trace",
        "distutils",
        "ensurepip",
        "venv",
        "site",
        "sysconfig",
        "builtins",
        "abc",
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
        "function_definition" | "decorated_definition" => {
            // decorated_definition wraps the actual definition
            let target = if kind == "decorated_definition" {
                node.child_by_field_name("definition")?
            } else {
                *node
            };
            let (name, s, e) = field_name_text(&target, source, "name")?;
            Some(make_def(name, DefKind::Function, s, e, depth))
        }
        "class_definition" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Class, s, e, depth))
        }
        "assignment" => {
            // Only simple `x = ...` (left is a single identifier)
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
            None
        }
        "import_from_statement" => {
            // `from x import y` -- we record `y` as an import
            // Walk named children looking for `dotted_name` / `aliased_import`
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                let ck = child.kind();
                if ck == "dotted_name" || ck == "aliased_import" {
                    // For aliased_import, the alias is the defined name
                    let name_node = if ck == "aliased_import" {
                        child.child_by_field_name("alias").unwrap_or(child)
                    } else {
                        child
                    };
                    // Take the last component of a dotted name
                    let text = name_node.utf8_text(source.as_bytes()).ok()?.trim();
                    let simple = text.rsplit('.').next().unwrap_or(text);
                    if !simple.is_empty() && is_valid_ident(simple) {
                        return Some(make_def(
                            simple,
                            DefKind::Import,
                            name_node.start_byte() as u32,
                            name_node.end_byte() as u32,
                            depth,
                        ));
                    }
                }
            }
            None
        }
        "import_statement" => {
            // `import x` or `import x as y`
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                let ck = child.kind();
                if ck == "dotted_name" || ck == "aliased_import" {
                    let name_node = if ck == "aliased_import" {
                        child.child_by_field_name("alias").unwrap_or(child)
                    } else {
                        child
                    };
                    let text = name_node.utf8_text(source.as_bytes()).ok()?.trim();
                    let simple = text.rsplit('.').next().unwrap_or(text);
                    if !simple.is_empty() && is_valid_ident(simple) {
                        return Some(make_def(
                            simple,
                            DefKind::Import,
                            name_node.start_byte() as u32,
                            name_node.end_byte() as u32,
                            depth,
                        ));
                    }
                }
            }
            None
        }
        "for_statement" => {
            // `for x in ...` -- left side identifier
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
            None
        }
        "parameters" | "lambda_parameters" => {
            // Record each identifier child as a parameter definition
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if child.kind() == "identifier" {
                    let text = child.utf8_text(source.as_bytes()).ok()?.trim();
                    if !text.is_empty() && text != "self" && text != "cls" {
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
        "default_parameter" | "typed_parameter" | "typed_default_parameter" => {
            let name_node = node.child_by_field_name("name").or_else(|| {
                // typed_parameter may have the identifier as first child
                let mut c = node.walk();
                let found = node
                    .named_children(&mut c)
                    .find(|ch| ch.kind() == "identifier");
                found
            })?;
            let text = name_node.utf8_text(source.as_bytes()).ok()?.trim();
            if !text.is_empty() && text != "self" && text != "cls" {
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
        _ => None,
    }
}
