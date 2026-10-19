// Ported from old_repo/src/components/ui/Button.tsx (lines 6-55)
import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";
interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Four variants, three sizes; the smallest is 44 px tall (law 2), so `sm` shrinks the type, not the target. It takes no `style`: the floor cannot be overridden through ...rest (ui-checks: button-rest-style). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant = "secondary", size = "md", type = "button", ...rest }, ref) => (
  <button ref={ref} type={type} className={`cl-btn cl-btn--${variant} cl-btn--${size}${className ? ` ${className}` : ""}`} {...rest} />
));
Button.displayName = "Button";
