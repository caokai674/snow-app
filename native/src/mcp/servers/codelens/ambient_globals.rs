use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use oxc::allocator::Allocator;
use oxc::ast::ast;
use oxc::ast_visit::Visit;
use oxc::parser::ParseOptions;
use oxc::span::SourceType;

/// Cached set of ambient global names loaded from TypeScript lib files.
/// Initialized once on first use; falls back to a minimal built-in set
/// if no TypeScript installation is found.
static AMBIENT_GLOBALS: OnceLock<HashSet<String>> = OnceLock::new();

/// Check whether `name` is a known ambient global.
/// On first call, attempts to load the full set from the project's
/// `node_modules/typescript/lib/` directory. If that fails, uses a
/// minimal fallback set of ECMAScript language intrinsics.
pub fn is_ambient_global(name: &str, file_path: &str) -> bool {
    let globals = AMBIENT_GLOBALS.get_or_init(|| load_globals_for_file(file_path));
    globals.contains(name)
}

/// Attempt to locate TypeScript lib files relative to `file_path` and
/// extract all declared global names. Falls back to the minimal set.
fn load_globals_for_file(file_path: &str) -> HashSet<String> {
    if let Some(lib_dir) = find_typescript_lib_dir(Path::new(file_path)) {
        let mut globals = HashSet::new();
        // lib.es5.d.ts contains ECMAScript built-ins (Object, Array, Promise, etc.)
        // lib.dom.d.ts contains browser/DOM APIs (MutationObserver, requestAnimationFrame, etc.)
        // lib.es2015+.d.ts contain newer ES features (Proxy, Reflect, etc.)
        let lib_files = [
            "lib.es5.d.ts",
            "lib.dom.d.ts",
            "lib.dom.iterable.d.ts",
            "lib.es2015.d.ts",
            "lib.es2015.core.d.ts",
            "lib.es2015.collection.d.ts",
            "lib.es2015.iterable.d.ts",
            "lib.es2015.generator.d.ts",
            "lib.es2015.promise.d.ts",
            "lib.es2015.proxy.d.ts",
            "lib.es2015.reflect.d.ts",
            "lib.es2015.symbol.d.ts",
            "lib.es2016.d.ts",
            "lib.es2016.array.include.d.ts",
            "lib.es2017.d.ts",
            "lib.es2017.object.d.ts",
            "lib.es2017.sharedmemory.d.ts",
            "lib.es2017.string.d.ts",
            "lib.es2017.intl.d.ts",
            "lib.es2017.typedarrays.d.ts",
            "lib.es2018.d.ts",
            "lib.es2018.asyncgenerator.d.ts",
            "lib.es2018.asynciterable.d.ts",
            "lib.es2018.intl.d.ts",
            "lib.es2018.promise.d.ts",
            "lib.es2018.regexp.d.ts",
            "lib.es2019.d.ts",
            "lib.es2019.array.d.ts",
            "lib.es2019.object.d.ts",
            "lib.es2019.string.d.ts",
            "lib.es2019.symbol.d.ts",
            "lib.es2020.d.ts",
            "lib.es2020.bigint.d.ts",
            "lib.es2020.promise.d.ts",
            "lib.es2020.sharedmemory.d.ts",
            "lib.es2020.string.d.ts",
            "lib.es2020.symbol.wellknown.d.ts",
            "lib.es2020.intl.d.ts",
            "lib.es2021.d.ts",
            "lib.es2021.intl.d.ts",
            "lib.es2021.promise.d.ts",
            "lib.es2021.string.d.ts",
            "lib.es2021.weakref.d.ts",
            "lib.es2022.d.ts",
            "lib.es2022.array.d.ts",
            "lib.es2022.error.d.ts",
            "lib.es2022.intl.d.ts",
            "lib.es2022.object.d.ts",
            "lib.es2022.sharedmemory.d.ts",
            "lib.es2022.string.d.ts",
            "lib.es2022.regexp.d.ts",
            "lib.es2023.d.ts",
            "lib.es2023.array.d.ts",
            "lib.es2023.collection.d.ts",
            "lib.esnext.d.ts",
            "lib.esnext.intl.d.ts",
            "lib.webworker.d.ts",
        ];

        for lib_name in &lib_files {
            let lib_path = lib_dir.join(lib_name);
            if lib_path.is_file() {
                if let Ok(source) = std::fs::read_to_string(&lib_path) {
                    extract_declared_names(&source, &mut globals);
                }
            }
        }

        // Also add Node.js-style globals that are not in TS lib files
        // but are universally available in Node/Electron environments.
        add_node_globals(&mut globals);

        if !globals.is_empty() {
            return globals;
        }
    }

    // Fallback: minimal ECMAScript intrinsics that are always valid
    fallback_globals()
}

/// Walk up from `start` looking for `node_modules/typescript/lib/`.
fn find_typescript_lib_dir(start: &Path) -> Option<PathBuf> {
    let mut dir = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };

    loop {
        let candidate = dir.join("node_modules").join("typescript").join("lib");
        if candidate.is_dir() {
            return Some(candidate);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Parse a `.d.ts` source and extract all top-level declared names.
fn extract_declared_names(source: &str, out: &mut HashSet<String>) {
    let allocator = Allocator::default();
    let source_type = SourceType::ts().with_typescript_definition(true);
    let parse_ret = oxc::parser::Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions {
            parse_regular_expression: false,
            ..ParseOptions::default()
        })
        .parse();

    let mut visitor = DeclaredNameVisitor { names: out };
    visitor.visit_program(&parse_ret.program);
}

struct DeclaredNameVisitor<'a> {
    names: &'a mut HashSet<String>,
}

impl<'a> Visit<'a> for DeclaredNameVisitor<'a> {
    fn visit_program(&mut self, program: &ast::Program<'a>) {
        for stmt in &program.body {
            self.extract_from_statement(stmt);
        }
    }
}

impl<'a> DeclaredNameVisitor<'a> {
    fn extract_from_statement(&mut self, stmt: &ast::Statement<'a>) {
        match stmt {
            ast::Statement::VariableDeclaration(decl) => {
                self.extract_from_variable_declaration(decl);
            }
            ast::Statement::FunctionDeclaration(func) => {
                if let Some(id) = &func.id {
                    self.names.insert(id.name.as_str().to_string());
                }
            }
            ast::Statement::ClassDeclaration(class) => {
                if let Some(id) = &class.id {
                    self.names.insert(id.name.as_str().to_string());
                }
            }
            ast::Statement::TSInterfaceDeclaration(iface) => {
                self.names.insert(iface.id.name.as_str().to_string());
            }
            ast::Statement::TSTypeAliasDeclaration(alias) => {
                self.names.insert(alias.id.name.as_str().to_string());
            }
            ast::Statement::TSEnumDeclaration(en) => {
                self.names.insert(en.id.name.as_str().to_string());
            }
            ast::Statement::TSModuleDeclaration(module) => {
                if let ast::TSModuleDeclarationName::Identifier(id) = &module.id {
                    self.names.insert(id.name.as_str().to_string());
                }
            }
            // Export declarations wrapping inner declarations
            ast::Statement::ExportNamedDeclaration(export) => {
                if let Some(decl) = &export.declaration {
                    self.extract_from_declaration(decl);
                }
            }
            ast::Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ast::ExportDefaultDeclarationKind::FunctionDeclaration(func) => {
                    if let Some(id) = &func.id {
                        self.names.insert(id.name.as_str().to_string());
                    }
                }
                ast::ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                    if let Some(id) = &class.id {
                        self.names.insert(id.name.as_str().to_string());
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }

    fn extract_from_declaration(&mut self, decl: &ast::Declaration<'a>) {
        match decl {
            ast::Declaration::VariableDeclaration(var_decl) => {
                self.extract_from_variable_declaration(var_decl);
            }
            ast::Declaration::FunctionDeclaration(func) => {
                if let Some(id) = &func.id {
                    self.names.insert(id.name.as_str().to_string());
                }
            }
            ast::Declaration::ClassDeclaration(class) => {
                if let Some(id) = &class.id {
                    self.names.insert(id.name.as_str().to_string());
                }
            }
            ast::Declaration::TSInterfaceDeclaration(iface) => {
                self.names.insert(iface.id.name.as_str().to_string());
            }
            ast::Declaration::TSTypeAliasDeclaration(alias) => {
                self.names.insert(alias.id.name.as_str().to_string());
            }
            ast::Declaration::TSEnumDeclaration(en) => {
                self.names.insert(en.id.name.as_str().to_string());
            }
            ast::Declaration::TSModuleDeclaration(module) => {
                if let ast::TSModuleDeclarationName::Identifier(id) = &module.id {
                    self.names.insert(id.name.as_str().to_string());
                }
            }
            _ => {}
        }
    }

    fn extract_from_variable_declaration(&mut self, decl: &ast::VariableDeclaration<'a>) {
        for declarator in &decl.declarations {
            if let Some(name) = binding_name(&declarator.id) {
                self.names.insert(name);
            }
        }
    }
}

fn binding_name(pattern: &ast::BindingPattern<'_>) -> Option<String> {
    match &pattern.kind {
        ast::BindingPatternKind::BindingIdentifier(id) => Some(id.name.as_str().to_string()),
        _ => None,
    }
}

/// Add Node.js / Electron globals that are not part of TypeScript's DOM/ES libs.
fn add_node_globals(globals: &mut HashSet<String>) {
    let node_names = [
        "process",
        "Buffer",
        "require",
        "module",
        "exports",
        "__dirname",
        "__filename",
        "global",
        "setImmediate",
        "clearImmediate",
        "queueMicrotask",
        "structuredClone",
        "console",
        "napi",
        "napi_derive",
        "tokio",
        "serde",
        "serde_json",
        "std",
        "self",
    ];
    for name in &node_names {
        globals.insert(name.to_string());
    }
}

/// Minimal fallback when no TypeScript installation is found.
/// Contains only ECMAScript language intrinsics that are universally valid.
fn fallback_globals() -> HashSet<String> {
    let names = [
        // ECMAScript intrinsics
        "undefined",
        "NaN",
        "Infinity",
        "globalThis",
        "Object",
        "Function",
        "Boolean",
        "Symbol",
        "Error",
        "TypeError",
        "RangeError",
        "ReferenceError",
        "SyntaxError",
        "EvalError",
        "URIError",
        "AggregateError",
        "Number",
        "BigInt",
        "Math",
        "Date",
        "String",
        "RegExp",
        "Array",
        "Int8Array",
        "Uint8Array",
        "Uint8ClampedArray",
        "Int16Array",
        "Uint16Array",
        "Int32Array",
        "Uint32Array",
        "Float32Array",
        "Float64Array",
        "BigInt64Array",
        "BigUint64Array",
        "Map",
        "Set",
        "WeakMap",
        "WeakSet",
        "ArrayBuffer",
        "SharedArrayBuffer",
        "DataView",
        "Atomics",
        "JSON",
        "Promise",
        "Generator",
        "GeneratorFunction",
        "AsyncFunction",
        "AsyncGenerator",
        "AsyncGeneratorFunction",
        "Reflect",
        "Proxy",
        "Intl",
        "FinalizationRegistry",
        "WeakRef",
        // Global functions
        "eval",
        "parseInt",
        "parseFloat",
        "isNaN",
        "isFinite",
        "decodeURI",
        "decodeURIComponent",
        "encodeURI",
        "encodeURIComponent",
        "escape",
        "unescape",
        // Timers (available in both browser and Node)
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "queueMicrotask",
        // Common cross-environment
        "console",
        "fetch",
        "URL",
        "URLSearchParams",
        "AbortController",
        "AbortSignal",
        "Event",
        "EventTarget",
        "CustomEvent",
        "TextEncoder",
        "TextDecoder",
        "structuredClone",
        // Node.js / Electron
        "process",
        "Buffer",
        "require",
        "module",
        "exports",
        "__dirname",
        "__filename",
        "global",
        "setImmediate",
        "clearImmediate",
        // Rust crate names that appear in napi context
        "napi",
        "napi_derive",
        "tokio",
        "serde",
        "serde_json",
        "std",
        "self",
    ];
    names.iter().map(|s| s.to_string()).collect()
}
