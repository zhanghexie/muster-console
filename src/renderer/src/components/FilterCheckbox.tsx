import { useLayoutEffect, useRef, type CSSProperties, type JSX, type RefObject } from 'react';

export function FilterColorDot({ color }: { color: string }): JSX.Element {
  return <span className="filter-color-dot" aria-hidden="true"
    style={{ '--filter-dot-color': color } as CSSProperties} />;
}

export function FilterCheckbox({ label, checked, color, mixed = false, inputRef, className, onChange }: {
  label: string;
  checked: boolean;
  color?: string;
  mixed?: boolean;
  inputRef?: RefObject<HTMLInputElement>;
  className?: string;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed, ref]);

  return (
    <label className={className ? `filter-checkbox-row ${className}` : 'filter-checkbox-row'}>
      <input ref={ref} type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
      {color ? <FilterColorDot color={color} /> : null}
      <span className="filter-row-label" title={label}>{label}</span>
    </label>
  );
}
