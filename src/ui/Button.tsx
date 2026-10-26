// Ported from old_repo/src/components/ui/Button.tsx (lines 6-55)
import Link from "next/link";
import { forwardRef, type ButtonHTMLAttributes, type ComponentProps } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";
interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** The dashed outline of an add-something action (+ Tag). */
  dashed?: boolean;
  /** A request in flight: the button shows a spinner, announces busy and cannot be pressed again. */
  loading?: boolean;
}

/** The one place the cl-btn classes are written: a link or a label that acts as a button takes this string too. */
export const buttonClass = (variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string, dashed = false): string =>
  `cl-btn cl-btn--${variant} cl-btn--${size}${dashed ? " cl-btn--dashed" : ""}${extra ? ` ${extra}` : ""}`;

/** Four variants, three sizes; the smallest is 44 px tall (law 2), so `sm` shrinks the type, not the target. It takes no `style`: the floor cannot be overridden through ...rest (ui-checks: button-rest-style). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, dashed, loading, disabled, type = "button", ...rest }, ref) => (
  <button ref={ref} type={type} className={buttonClass(variant, size, className, dashed)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest} />
));
Button.displayName = "Button";

/** A navigation that looks like a button: the same look as Button, rendered as a link. */
export function ButtonLink({ variant, size, className, ...rest }: Omit<ComponentProps<typeof Link>, "style" | "className"> & { variant?: ButtonVariant; size?: ButtonSize; className?: string }) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}
