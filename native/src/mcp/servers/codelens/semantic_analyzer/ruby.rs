use std::collections::HashSet;

use tree_sitter::Node;

use super::{field_name_text, make_def, DefKind, Definition};

pub fn builtins() -> HashSet<&'static str> {
    [
        // keywords
        "self",
        "nil",
        "true",
        "false",
        "__FILE__",
        "__LINE__",
        "__method__",
        "__dir__",
        "__callee__",
        "__ENCODING__",
        // Kernel methods
        "puts",
        "print",
        "p",
        "pp",
        "gets",
        "require",
        "require_relative",
        "include",
        "extend",
        "attr_reader",
        "attr_writer",
        "attr_accessor",
        "raise",
        "fail",
        "catch",
        "throw",
        "lambda",
        "proc",
        "block_given?",
        "yield",
        "caller",
        "binding",
        "eval",
        "instance_eval",
        "class_eval",
        "module_eval",
        "loop",
        "sleep",
        "exit",
        "abort",
        "at_exit",
        "rand",
        "srand",
        "format",
        "sprintf",
        "warn",
        "system",
        "exec",
        "spawn",
        "fork",
        "trap",
        "open",
        "readlines",
        "select",
        // core classes
        "Object",
        "BasicObject",
        "Class",
        "Module",
        "String",
        "Integer",
        "Float",
        "Numeric",
        "Array",
        "Hash",
        "Symbol",
        "Range",
        "Regexp",
        "Proc",
        "Method",
        "UnboundMethod",
        "Binding",
        "Continuation",
        "Thread",
        "Mutex",
        "ConditionVariable",
        "Queue",
        "SizedQueue",
        "IO",
        "File",
        "Dir",
        "FileTest",
        "Stat",
        "Tempfile",
        "StringIO",
        "Enumerable",
        "Comparable",
        "Kernel",
        "Math",
        "GC",
        "ObjectSpace",
        "Marshal",
        "Signal",
        "Process",
        "Random",
        "Time",
        "Struct",
        "Data",
        "Set",
        "SortedSet",
        "OpenStruct",
        "Struct",
        "Exception",
        "StandardError",
        "RuntimeError",
        "TypeError",
        "ArgumentError",
        "NameError",
        "NoMethodError",
        "ZeroDivisionError",
        "FloatDomainError",
        "RangeError",
        "IndexError",
        "KeyError",
        "StopIteration",
        "SystemCallError",
        "Errno",
        "IOError",
        "EOFError",
        "SecurityError",
        "NoMemoryError",
        "ScriptError",
        "SyntaxError",
        "LoadError",
        "NotImplementedError",
        "FrozenError",
        "EncodingError",
        "SystemExit",
        "Interrupt",
        "SignalException",
        "NilClass",
        "TrueClass",
        "FalseClass",
        // common stdlib
        "JSON",
        "CSV",
        "YAML",
        "Logger",
        "OptParse",
        "OptionParser",
        "Net",
        "URI",
        "OpenURI",
        "Pathname",
        "FileUtils",
        "Digest",
        "Base64",
        "SecureRandom",
        "Benchmark",
        "Date",
        "DateTime",
        "BigDecimal",
        "Complex",
        "Rational",
        "Matrix",
        "Vector",
        "Socket",
        "TCPSocket",
        "UDPSocket",
        "IPSocket",
        "UNIXSocket",
        "WEBrick",
        "ERB",
        "CGI",
        "Rake",
        "RSpec",
        "Minitest",
        "Test",
        "Unit",
        "MiniTest",
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
        "method" | "singleton_method" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Function, s, e, depth))
        }
        "class" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Class, s, e, depth))
        }
        "module" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Module, s, e, depth))
        }
        "assignment" => {
            let left = node.child_by_field_name("left")?;
            if left.kind() == "identifier"
                || left.kind() == "constant"
                || left.kind() == "instance_variable"
                || left.kind() == "class_variable"
                || left.kind() == "global_variable"
            {
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
        "method_parameters" | "block_parameters" | "lambda_parameters" => {
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
