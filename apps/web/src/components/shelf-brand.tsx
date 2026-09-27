/** Shared brand lockup, including the dependency-free viewer boot states. */
export function ShelfBrand({ className = '' }: { readonly className?: string }) {
  return (
    <span className={`wordmark ${className}`.trim()}>
      <span aria-hidden="true" className="shelf-brand-mark" />
      <span>shelf</span>
    </span>
  );
}
