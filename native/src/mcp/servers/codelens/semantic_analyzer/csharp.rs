use std::collections::HashSet;

use tree_sitter::Node;

use super::{field_name_text, is_valid_ident, make_def, DefKind, Definition};

pub fn builtins() -> HashSet<&'static str> {
    [
        // types
        "bool",
        "byte",
        "sbyte",
        "char",
        "decimal",
        "double",
        "float",
        "int",
        "uint",
        "nint",
        "nuint",
        "long",
        "ulong",
        "short",
        "ushort",
        "string",
        "object",
        "dynamic",
        "void",
        "var",
        // keywords
        "this",
        "base",
        "null",
        "true",
        "false",
        "value",
        // System
        "Console",
        "Math",
        "Convert",
        "Environment",
        "GC",
        "AppDomain",
        "Exception",
        "SystemException",
        "ArgumentException",
        "ArgumentNullException",
        "InvalidOperationException",
        "NotImplementedException",
        "NotSupportedException",
        "NullReferenceException",
        "IndexOutOfRangeException",
        "OverflowException",
        "InvalidCastException",
        "FormatException",
        "ObjectDisposedException",
        "OutOfMemoryException",
        "StackOverflowException",
        "Type",
        "Activator",
        "Attribute",
        "IDisposable",
        "IComparable",
        "IEquatable",
        "IEnumerable",
        "IEnumerator",
        "ICloneable",
        "IFormattable",
        "IServiceProvider",
        "EventHandler",
        "EventArgs",
        "Action",
        "Func",
        "Predicate",
        "Comparison",
        "Converter",
        "Nullable",
        "Tuple",
        "ValueTuple",
        "Guid",
        "DateTime",
        "DateTimeOffset",
        "TimeSpan",
        "Random",
        "Version",
        "Uri",
        "Lazy",
        // collections
        "List",
        "Dictionary",
        "HashSet",
        "SortedSet",
        "SortedDictionary",
        "SortedList",
        "Queue",
        "Stack",
        "LinkedList",
        "ArrayList",
        "Hashtable",
        "BitArray",
        "Collection",
        "ReadOnlyCollection",
        "ObservableCollection",
        "IList",
        "ICollection",
        "IEnumerable",
        "IDictionary",
        "ISet",
        "IReadOnlyList",
        "IReadOnlyCollection",
        "IReadOnlyDictionary",
        "KeyValuePair",
        // LINQ
        "Enumerable",
        "Queryable",
        "IGrouping",
        "ILookup",
        "IOrderedEnumerable",
        // Task / async
        "Task",
        "ValueTask",
        "CancellationToken",
        "CancellationTokenSource",
        "ConfigureAwait",
        // attributes
        "Serializable",
        "Obsolete",
        "Flags",
        "DllImport",
        "MarshalAs",
        "StructLayout",
        "ThreadStatic",
        "Conditional",
        "DebuggerDisplay",
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
        "class_declaration" | "struct_declaration" | "enum_declaration" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Class, s, e, depth))
        }
        "interface_declaration" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Type, s, e, depth))
        }
        "local_declaration_statement" | "field_declaration" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if child.kind() == "variable_declarator" || child.kind() == "variable_declaration" {
                    // variable_declarator has a name field
                    if let Some((name, s, e)) = field_name_text(&child, source, "name") {
                        return Some(make_def(name, DefKind::Variable, s, e, depth));
                    }
                    // variable_declaration -> variable_declarator
                    let mut c2 = child.walk();
                    for gc in child.named_children(&mut c2) {
                        if let Some((name, s, e)) = field_name_text(&gc, source, "name") {
                            return Some(make_def(name, DefKind::Variable, s, e, depth));
                        }
                    }
                }
            }
            None
        }
        "parameter" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Parameter, s, e, depth))
        }
        "property_declaration" => {
            let (name, s, e) = field_name_text(node, source, "name")?;
            Some(make_def(name, DefKind::Variable, s, e, depth))
        }
        "using_directive" => {
            let text = node.utf8_text(source.as_bytes()).ok()?.trim();
            let simple = text
                .trim_start_matches("using")
                .trim()
                .trim_end_matches(';')
                .rsplit('.')
                .next()
                .unwrap_or("")
                .trim();
            if !simple.is_empty() && is_valid_ident(simple) {
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
