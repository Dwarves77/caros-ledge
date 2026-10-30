"use client";

// Ported from old_repo/src/components/account/AccountPrimitives.tsx (lines 1-452)
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

import { CardFoot } from "./SmallParts";
import { SectionCard } from "./SectionCard";
import { SectionHead } from "./SectionHead";

/** What a control inside a FormField must carry so the label, the hint and the error belong to it. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  required?: true;
}

interface FormFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** The reason the value is refused; shown under the control and wired to it. */
  error?: string | null | undefined;
  required?: boolean;
  /** The control is a group (segmented buttons, chips) that names itself: the label is a caption, not a `for` link to one input. */
  group?: boolean;
  /** A render prop: the control receives its id and descriptions, so no caller wires a label by hand. */
  children: (control: FieldControlProps) => ReactNode;
}

/** THE form row: a label, one control, an optional hint and error. Every field on every surface is this part. */
export function FormField({ label, hint, error, required, group, children }: FormFieldProps) {
  const id = useId();
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="cl-field">
      {group ? (
        <span className="cl-field-label">{label}</span>
      ) : (
        <label htmlFor={id} className="cl-field-label">
          {label}
          {required ? <span aria-hidden="true"> *</span> : null}
        </label>
      )}
      {children({ id, ...(described ? { "aria-describedby": described } : {}), ...(error ? { "aria-invalid": true as const } : {}), ...(required ? { required: true as const } : {}) })}
      {hint ? (
        <p id={`${id}-hint`} className="cl-field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="cl-field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { bare?: boolean }>(({ className, bare, ...rest }, ref) => <input ref={ref} className={bare ? className : `cl-input${className ? ` ${className}` : ""}`} {...rest} />);
Input.displayName = "Input";
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { bare?: boolean }>(({ className, bare, rows = 4, ...rest }, ref) => <textarea ref={ref} rows={rows} className={bare ? className : `cl-input${className ? ` ${className}` : ""}`} {...rest} />);
Textarea.displayName = "Textarea";
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...rest }, ref) => <select ref={ref} className={`cl-input${className ? ` ${className}` : ""}`} {...rest} />);
Select.displayName = "Select";

/** A switch: a 44 px target around a 32 x 18 track. `locked` is on and cannot be flipped (it still says why through `label`). */
export function Switch({ on, onChange, label, locked, busy }: { on: boolean; onChange: (next: boolean) => void; label: string; locked?: boolean; busy?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} aria-disabled={locked || busy || undefined} disabled={locked || busy} className="cl-switch" onClick={() => onChange(!on)}>
      <span aria-hidden="true" className="cl-switch-track">
        <span className="cl-switch-knob" />
      </span>
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
}

/** One choice (radio group) or several (pressed buttons) from a short list; every segment is 44 px. */
export function Segmented<T extends string>({ options, selected, onSelect, label, multiple, disabled }: { options: ReadonlyArray<SegmentedOption<T>>; selected: ReadonlyArray<T>; onSelect: (id: T) => void; label: string; multiple?: boolean; disabled?: boolean }) {
  return (
    <div role={multiple ? "group" : "radiogroup"} aria-label={label} className="cl-seg">
      {options.map((o) => {
        const on = selected.includes(o.id);
        return (
          <button key={o.id} type="button" role={multiple ? undefined : "radio"} aria-checked={multiple ? undefined : on} aria-pressed={multiple ? on : undefined} disabled={disabled} className="cl-seg-item" onClick={() => onSelect(o.id)}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A toggle choice with its check mark: sectors, jurisdictions, roles, sizes. 44 px tall; the pressed state is not carried by colour alone (the mark fills). */
export function ChoiceChip({ label, pressed, onToggle, disabled }: { label: string; pressed: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-pressed={pressed} disabled={disabled} className="cl-choice" onClick={onToggle}>
      <span aria-hidden="true" className="cl-choice-mark" />
      <span className="cl-choice-label">{label}</span>
    </button>
  );
}

/** The card every settings and account section is: the shared card, its head, a padded body and an optional foot. */
export function FormCard({ title, aside, children, foot, id }: { title: string; aside?: ReactNode; children: ReactNode; foot?: { left: ReactNode; right: ReactNode }; id?: string }) {
  return (
    <SectionCard as="section" aria-label={title} {...(id ? { id } : {})}>
      <SectionHead title={title} {...(aside ? { aside } : {})} />
      <div className="cl-form-body">{children}</div>
      {foot ? <CardFoot left={foot.left} right={foot.right} /> : null}
    </SectionCard>
  );
}
