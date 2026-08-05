//! Lightweight semantic analyzer built on top of tree-sitter.
//!
//! Performs scope-aware analysis for tree-sitter-supported languages:
//! - Unresolved reference detection (identifier used but never defined)
//! - Unused variable / import detection
//!
//! This complements the syntax-only diagnostics in `tree_sitter_analyzer.rs`
//! by adding a semantic layer similar to what oxc provides for JS/TS.

mod bash;
mod c_lang;
mod csharp;
mod go;
mod java;
mod lua;
mod php;
mod python;
mod ruby;
mod rust_lang;

use std::collections::HashSet;

use tree_sitter::{Node, Tree};

use super::analyzer::LineIndex;
use super::tree_sitter_analyzer::TsLang;
use super::types::{DiagnosticItem, DiagnosticSeverity};

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

/// A symbol definition discovered in the source file.
#[derive(Debug, Clone)]
struct Definition {
    name: String,
    kind: DefKind,
    /// Byte offset where the definition name starts.
    start_byte: u32,
    /// Byte offset where the definition name ends.
    end_byte: u32,
    /// Nesting depth (0 = top-level).
    depth: usize,
}

/// A reference (usage) of an identifier in the source file.
#[derive(Debug, Clone)]
struct Reference {
    name: String,
    start_byte: u32,
    end_byte: u32,
    depth: usize,
}

/// Categories of definitions we track.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DefKind {
    Function,
    Class,
    Variable,
    Import,
    Parameter,
    Type,
    Constant,
    Module,
}

/// Result of semantic analysis.
pub struct SemanticResult {
    pub diagnostics: Vec<DiagnosticItem>,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Run semantic analysis on a parsed tree-sitter tree.
/// Returns diagnostics for unresolved references and unused variables.
pub fn analyze_semantics(
    lang: TsLang,
    tree: &Tree,
    source: &str,
    line_index: &LineIndex,
) -> SemanticResult {
    // Only run semantic analysis for languages where it is meaningful.
    // Markup / data languages (CSS, HTML, JSON, YAML) do not have
    // identifier-based scoping, so we skip them.
    if !lang_supports_semantics(lang) {
        return SemanticResult {
            diagnostics: Vec::new(),
        };
    }

    let mut definitions: Vec<Definition> = Vec::new();
    let mut references: Vec<Reference> = Vec::new();

    collect_definitions_and_refs(
        &tree.root_node(),
        source,
        lang,
        &mut definitions,
        &mut references,
    );

    let builtins = builtin_symbols(lang);
    let diagnostics = build_diagnostics(
        &definitions,
        &references,
        &builtins,
        source,
        line_index,
        lang,
    );

    SemanticResult { diagnostics }
}

fn lang_supports_semantics(lang: TsLang) -> bool {
    matches!(
        lang,
        TsLang::Python
            | TsLang::Rust
            | TsLang::Go
            | TsLang::C
            | TsLang::Java
            | TsLang::CSharp
            | TsLang::Ruby
            | TsLang::Php
            | TsLang::Lua
            | TsLang::Bash
    )
}

// ---------------------------------------------------------------------------
// Builtin / known-global symbols per language
// ---------------------------------------------------------------------------

fn builtin_symbols(lang: TsLang) -> HashSet<&'static str> {
    match lang {
        TsLang::Python => python::builtins(),
        TsLang::Rust => rust_lang::builtins(),
        TsLang::Go => go::builtins(),
        TsLang::C => c_lang::builtins(),
        TsLang::Java => java::builtins(),
        TsLang::CSharp => csharp::builtins(),
        TsLang::Ruby => ruby::builtins(),
        TsLang::Php => php::builtins(),
        TsLang::Lua => lua::builtins(),
        TsLang::Bash => bash::builtins(),
        _ => HashSet::new(),
    }
}

// ---------------------------------------------------------------------------
// Tree walking: collect definitions and references
// ---------------------------------------------------------------------------

/// Two-phase collection: first definitions, then references.
fn collect_definitions_and_refs(
    root: &Node,
    source: &str,
    lang: TsLang,
    definitions: &mut Vec<Definition>,
    references: &mut Vec<Reference>,
) {
    // Phase 1: collect definitions and record name byte-ranges
    let mut def_name_ranges: HashSet<(u32, u32)> = HashSet::new();
    collect_definitions(root, source, lang, 0, definitions, &mut def_name_ranges);

    // Phase 2: collect references, excluding definition-name spans
    collect_references(root, source, lang, 0, &def_name_ranges, references);
}

fn collect_definitions(
    node: &Node,
    source: &str,
    lang: TsLang,
    depth: usize,
    definitions: &mut Vec<Definition>,
    def_name_ranges: &mut HashSet<(u32, u32)>,
) {
    if let Some(def) = try_extract_definition(node, source, lang, depth) {
        def_name_ranges.insert((def.start_byte, def.end_byte));
        definitions.push(def);
    }

    let child_depth = if is_scope_node(node.kind(), lang) {
        depth + 1
    } else {
        depth
    };

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_definitions(
            &child,
            source,
            lang,
            child_depth,
            definitions,
            def_name_ranges,
        );
    }
}

/// Whether to skip an entire subtree during reference collection.
/// These node kinds contain identifiers that are not meaningful
/// standalone references (import paths, attribute arguments, qualified
/// paths, macro tokens, etc.).
fn should_skip_subtree(kind: &str, lang: TsLang) -> bool {
    match lang {
        TsLang::Rust => matches!(
            kind,
            "attribute_item"
                | "inner_attribute_item"
                | "use_declaration"
                | "macro_invocation"
                | "macro_definition"
                | "scoped_identifier"
                | "scoped_type_identifier"
        ),
        TsLang::Python => matches!(kind, "import_statement" | "import_from_statement"),
        TsLang::Go => matches!(kind, "import_declaration"),
        TsLang::C => matches!(
            kind,
            "preproc_include" | "preproc_def" | "preproc_function_def"
        ),
        TsLang::Java => matches!(
            kind,
            "import_declaration" | "marker_annotation" | "annotation"
        ),
        TsLang::CSharp => matches!(kind, "using_directive" | "attribute_list"),
        TsLang::Php => matches!(kind, "namespace_use_declaration" | "attribute_list"),
        _ => false,
    }
}

/// When we skip a subtree (macro_invocation, scoped_identifier, etc.) we may
/// still need to record a reference for the *name* portion of that node:
///
/// - `macro_invocation` -> the macro name (first identifier child) is a real
///   reference to the imported macro, e.g. `json!(...)`.
/// - `scoped_identifier` / `scoped_type_identifier` -> the *last* segment is a
///   real reference to the imported item, e.g. `ThreadsafeFunction` in
///   `napi::threadsafe_function::ThreadsafeFunction`.
fn record_skipped_node_reference(
    node: &Node,
    source: &str,
    lang: TsLang,
    depth: usize,
    def_name_ranges: &HashSet<(u32, u32)>,
    references: &mut Vec<Reference>,
) {
    let kind = node.kind();

    if lang == TsLang::Rust && kind == "macro_invocation" {
        // The macro name is the first named child (an identifier).
        if let Some(macro_name) = node.named_child(0) {
            if macro_name.kind() == "identifier" {
                let s = macro_name.start_byte() as u32;
                let e = macro_name.end_byte() as u32;
                if !def_name_ranges.contains(&(s, e)) {
                    if let Ok(text) = macro_name.utf8_text(source.as_bytes()) {
                        let text = text.trim();
                        if !text.is_empty() && is_valid_ident(text) {
                            references.push(Reference {
                                name: text.to_string(),
                                start_byte: s,
                                end_byte: e,
                                depth,
                            });
                        }
                    }
                }
            }
        }
        return;
    }

    if lang == TsLang::Rust && (kind == "scoped_identifier" || kind == "scoped_type_identifier") {
        // The last named child is the trailing segment -- the actual item being
        // referenced (e.g. `ThreadsafeFunction` in `a::b::ThreadsafeFunction`).
        let last_idx = node.named_child_count().saturating_sub(1);
        if let Some(trailing) = node.named_child(last_idx) {
            let tk = trailing.kind();
            if tk == "identifier" || tk == "type_identifier" {
                let s = trailing.start_byte() as u32;
                let e = trailing.end_byte() as u32;
                if !def_name_ranges.contains(&(s, e)) {
                    if let Ok(text) = trailing.utf8_text(source.as_bytes()) {
                        let text = text.trim();
                        if !text.is_empty() && is_valid_ident(text) {
                            references.push(Reference {
                                name: text.to_string(),
                                start_byte: s,
                                end_byte: e,
                                depth,
                            });
                        }
                    }
                }
            }
        }
        return;
    }

    // For other skipped subtrees (use_declaration, import paths, etc.) we
    // don't need to record anything extra -- the definitions phase already
    // captured the imported names.
    let _ = (source, def_name_ranges);
}

fn collect_references(
    node: &Node,
    source: &str,
    lang: TsLang,
    depth: usize,
    def_name_ranges: &HashSet<(u32, u32)>,
    references: &mut Vec<Reference>,
) {
    // Skip entire subtrees that don't contain meaningful references.
    // However, for macro_invocation we still need to record the macro name
    // itself as a reference (e.g. `json!({...})` -- the `json` identifier is
    // a use of the imported macro).  Same for scoped_identifier /
    // scoped_type_identifier -- their trailing segment is a real reference.
    if should_skip_subtree(node.kind(), lang) {
        record_skipped_node_reference(node, source, lang, depth, def_name_ranges, references);
        return;
    }

    let start = node.start_byte() as u32;
    let end = node.end_byte() as u32;

    if is_reference_identifier(node, lang) && !def_name_ranges.contains(&(start, end)) {
        // Skip property / field accesses (the right-hand side of `a.b`)
        if !is_property_access(node) {
            if let Ok(text) = node.utf8_text(source.as_bytes()) {
                let text = text.trim();
                if !text.is_empty() && is_valid_ident(text) {
                    references.push(Reference {
                        name: text.to_string(),
                        start_byte: start,
                        end_byte: end,
                        depth,
                    });
                }
            }
        }
    }

    let child_depth = if is_scope_node(node.kind(), lang) {
        depth + 1
    } else {
        depth
    };

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_references(
            &child,
            source,
            lang,
            child_depth,
            def_name_ranges,
            references,
        );
    }
}

// ---------------------------------------------------------------------------
// Definition extraction (per-language)
// ---------------------------------------------------------------------------

/// Try to extract a definition from the given node.
/// Returns `Some(Definition)` if the node introduces a new name.
fn try_extract_definition(
    node: &Node,
    source: &str,
    lang: TsLang,
    depth: usize,
) -> Option<Definition> {
    let kind = node.kind();

    match lang {
        TsLang::Python => python::extract_definition(node, source, kind, depth),
        TsLang::Rust => rust_lang::extract_definition(node, source, kind, depth),
        TsLang::Go => go::extract_definition(node, source, kind, depth),
        TsLang::C => c_lang::extract_definition(node, source, kind, depth),
        TsLang::Java => java::extract_definition(node, source, kind, depth),
        TsLang::CSharp => csharp::extract_definition(node, source, kind, depth),
        TsLang::Ruby => ruby::extract_definition(node, source, kind, depth),
        TsLang::Php => php::extract_definition(node, source, kind, depth),
        TsLang::Lua => lua::extract_definition(node, source, kind, depth),
        TsLang::Bash => bash::extract_definition(node, source, kind, depth),
        _ => None,
    }
}

/// Helper: get the text of a named field child.
fn field_name_text<'a>(node: &Node, source: &'a str, field: &str) -> Option<(&'a str, u32, u32)> {
    let child = node.child_by_field_name(field)?;
    let text = child.utf8_text(source.as_bytes()).ok()?.trim();
    if text.is_empty() {
        return None;
    }
    Some((text, child.start_byte() as u32, child.end_byte() as u32))
}

fn make_def(name: &str, kind: DefKind, start_byte: u32, end_byte: u32, depth: usize) -> Definition {
    Definition {
        name: name.to_string(),
        kind,
        start_byte,
        end_byte,
        depth,
    }
}

// ---------------------------------------------------------------------------
// Reference identification helpers
// ---------------------------------------------------------------------------

/// Check whether a node is an identifier that should be treated as a reference.
fn is_reference_identifier(node: &Node, lang: TsLang) -> bool {
    let kind = node.kind();
    match lang {
        TsLang::Python => kind == "identifier",
        TsLang::Rust => kind == "identifier" || kind == "type_identifier",
        TsLang::Go => {
            kind == "identifier" || kind == "type_identifier" || kind == "field_identifier"
        }
        TsLang::C => {
            kind == "identifier" || kind == "type_identifier" || kind == "field_identifier"
        }
        TsLang::Java => kind == "identifier" || kind == "type_identifier",
        TsLang::CSharp => kind == "identifier" || kind == "type_identifier",
        TsLang::Ruby => {
            kind == "identifier"
                || kind == "constant"
                || kind == "instance_variable"
                || kind == "class_variable"
                || kind == "global_variable"
        }
        TsLang::Php => kind == "name" || kind == "variable_name",
        TsLang::Lua => kind == "identifier",
        TsLang::Bash => kind == "word" || kind == "variable_name",
        _ => false,
    }
}

/// Check whether this node is the property/field part of a member access
/// (e.g. the `bar` in `foo.bar`), which should NOT be treated as a
/// standalone reference.
fn is_property_access(node: &Node) -> bool {
    if let Some(parent) = node.parent() {
        let pk = parent.kind();
        // Common member-access node kinds across grammars
        if pk == "member_expression"
            || pk == "attribute"
            || pk == "field_expression"
            || pk == "field_access"
            || pk == "member_access_expression"
            || pk == "scoped_identifier"
            || pk == "qualified_name"
            || pk == "dotted_name"
            || pk == "property_access_expression"
            || pk == "element_access_expression"
            || pk == "navigation_expression"
            || pk == "scope_resolution"
        {
            // The node is a property if it is NOT the first named child
            // (the object / receiver side).
            if let Some(first) = parent.named_child(0) {
                if first.id() == node.id() {
                    return false; // this is the receiver, keep it as a reference
                }
            }
            // Check field name -- most grammars use "attribute" or "property"
            // for the right-hand side.
            if let Some(attr) = parent.child_by_field_name("attribute") {
                if attr.id() == node.id() {
                    return true;
                }
            }
            if let Some(prop) = parent.child_by_field_name("property") {
                if prop.id() == node.id() {
                    return true;
                }
            }
            if let Some(name) = parent.child_by_field_name("name") {
                if name.id() == node.id() {
                    return true;
                }
            }
            // Fallback: if the node is the second (or later) named child,
            // treat it as a property.
            if parent.named_child_count() > 1 {
                if let Some(first) = parent.named_child(0) {
                    if first.id() != node.id() {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Whether a node kind introduces a new scope.
fn is_scope_node(kind: &str, lang: TsLang) -> bool {
    match lang {
        TsLang::Python => matches!(
            kind,
            "function_definition"
                | "class_definition"
                | "lambda"
                | "for_statement"
                | "while_statement"
                | "if_statement"
                | "with_statement"
                | "try_statement"
                | "decorated_definition"
        ),
        TsLang::Rust => matches!(
            kind,
            "function_item"
                | "struct_item"
                | "enum_item"
                | "trait_item"
                | "impl_item"
                | "mod_item"
                | "block"
                | "closure_expression"
                | "match_arm"
                | "for_expression"
                | "while_expression"
                | "loop_expression"
                | "if_expression"
        ),
        TsLang::Go => matches!(
            kind,
            "function_declaration"
                | "method_declaration"
                | "block"
                | "func_literal"
                | "for_statement"
                | "if_statement"
                | "type_declaration"
        ),
        TsLang::C => matches!(
            kind,
            "function_definition"
                | "compound_statement"
                | "for_statement"
                | "while_statement"
                | "if_statement"
                | "struct_specifier"
                | "enum_specifier"
        ),
        TsLang::Java => matches!(
            kind,
            "method_declaration"
                | "class_declaration"
                | "interface_declaration"
                | "enum_declaration"
                | "block"
                | "for_statement"
                | "if_statement"
                | "try_statement"
                | "constructor_declaration"
        ),
        TsLang::CSharp => matches!(
            kind,
            "method_declaration"
                | "class_declaration"
                | "interface_declaration"
                | "struct_declaration"
                | "enum_declaration"
                | "block"
                | "for_statement"
                | "if_statement"
                | "try_statement"
                | "constructor_declaration"
                | "property_declaration"
        ),
        TsLang::Ruby => matches!(
            kind,
            "method"
                | "singleton_method"
                | "class"
                | "module"
                | "block"
                | "do_block"
                | "if"
                | "unless"
                | "while"
                | "until"
                | "for"
                | "begin"
                | "case"
        ),
        TsLang::Php => matches!(
            kind,
            "function_definition"
                | "method_declaration"
                | "class_declaration"
                | "interface_declaration"
                | "compound_statement"
                | "for_statement"
                | "if_statement"
                | "try_statement"
        ),
        TsLang::Lua => matches!(
            kind,
            "function_declaration"
                | "function"
                | "for_statement"
                | "for_numeric_loop"
                | "for_generic_loop"
                | "if_statement"
                | "while_statement"
                | "repeat_statement"
                | "do_statement"
        ),
        TsLang::Bash => matches!(
            kind,
            "function_definition"
                | "for_statement"
                | "while_statement"
                | "if_statement"
                | "case_statement"
                | "subshell"
        ),
        _ => false,
    }
}

/// Basic identifier validation: starts with letter/underscore, rest alphanumeric.
fn is_valid_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_alphabetic() || c == '_' || c == '$' => {}
        _ => return false,
    }
    chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

// ---------------------------------------------------------------------------
// Diagnostic generation
// ---------------------------------------------------------------------------

/// Cross-reference definitions and references to produce diagnostics.
fn build_diagnostics(
    definitions: &[Definition],
    references: &[Reference],
    builtins: &HashSet<&'static str>,
    _source: &str,
    line_index: &LineIndex,
    lang: TsLang,
) -> Vec<DiagnosticItem> {
    let mut diagnostics: Vec<DiagnosticItem> = Vec::new();

    // Build a set of all defined names for quick lookup.
    let defined_names: HashSet<&str> = definitions.iter().map(|d| d.name.as_str()).collect();

    // Track which definition names are actually referenced.
    let mut referenced_names: HashSet<&str> = HashSet::new();

    // --- Unresolved references ---
    for r in references {
        if defined_names.contains(r.name.as_str()) {
            referenced_names.insert(r.name.as_str());
            continue;
        }
        if builtins.contains(r.name.as_str()) {
            continue;
        }
        // Skip very short names (likely noise from partial parses)
        if r.name.len() <= 1 {
            continue;
        }
        // Skip names that start with an uppercase letter in languages where
        // that conventionally means a type (Rust, Go, Ruby, C#, Java).
        // Without full type inference / cross-crate name resolution we cannot
        // reliably determine whether a type identifier is defined elsewhere
        // (e.g. in another module), so reporting them would be pure noise.
        if should_skip_uppercase_unresolved(lang)
            && r.name
                .chars()
                .next()
                .map(|c| c.is_uppercase())
                .unwrap_or(false)
        {
            // Still record it as referenced so that the *import* of that
            // uppercase name is not wrongly flagged as unused.
            referenced_names.insert(r.name.as_str());
            continue;
        }

        let (start_line, start_col) = line_index.line_col(r.start_byte);
        let (end_line, end_col) = line_index.line_col(r.end_byte);

        diagnostics.push(DiagnosticItem {
            severity: DiagnosticSeverity::Warning.as_str().to_string(),
            message: format!(
                "Cannot find name '{}'. It is not defined in this file and is not a known built-in.",
                r.name
            ),
            start_line,
            end_line,
            start_column: start_col,
            end_column: end_col,
            source: "codelens-semantic".to_string(),
            code: Some("unresolved-reference".to_string()),
        });
    }

    // --- Unused variables / imports ---
    // Only report variables and imports that are never referenced.
    // Skip parameters (they are often intentionally unused) and
    // names starting with `_` (convention for intentionally unused).
    for d in definitions {
        if d.kind != DefKind::Variable && d.kind != DefKind::Import {
            continue;
        }
        if d.name.starts_with('_') {
            continue;
        }
        if referenced_names.contains(d.name.as_str()) {
            continue;
        }
        // Also skip if the name appears in builtins (e.g. shadowing)
        if builtins.contains(d.name.as_str()) {
            continue;
        }

        let (start_line, start_col) = line_index.line_col(d.start_byte);
        let (end_line, end_col) = line_index.line_col(d.end_byte);

        let kind_label = match d.kind {
            DefKind::Import => "import",
            _ => "variable",
        };

        diagnostics.push(DiagnosticItem {
            severity: DiagnosticSeverity::Warning.as_str().to_string(),
            message: format!(
                "{} '{}' is defined but never used.",
                capitalize(kind_label),
                d.name
            ),
            start_line,
            end_line,
            start_column: start_col,
            end_column: end_col,
            source: "codelens-semantic".to_string(),
            code: Some("unused-definition".to_string()),
        });
    }

    diagnostics
}

/// Whether unresolved-reference diagnostics for uppercase-starting names
/// should be suppressed for this language.  In statically-typed languages
/// (Rust, Go, C, Java, C#) uppercase identifiers are typically types or
/// constructor names that are defined in other modules/crates, which our
/// single-file analyzer cannot resolve.  Reporting them would be noise.
fn should_skip_uppercase_unresolved(lang: TsLang) -> bool {
    matches!(
        lang,
        TsLang::Rust | TsLang::Go | TsLang::C | TsLang::Java | TsLang::CSharp
    )
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}
