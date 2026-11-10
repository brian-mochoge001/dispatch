// Metro resolves CSS modules for the web build; TypeScript needs the shape.
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

// Side-effect CSS imports (for example `import '@/global.css'`) are handled by
// Metro; TypeScript 6 checks them unless a wildcard module is declared.
declare module '*.css';
