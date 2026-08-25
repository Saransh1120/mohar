/**
 * Magnetic button — ported from the supplied `motion-footer` primitive.
 *
 * Two deviations from the original, both forced by this project rather than by
 * preference: there is no `cn()` here because the repo has no `@/lib/utils`, and
 * there is no `"use client"` because this is a Vite SPA, not Next.js.
 *
 * The pointer check matters. On a touch device `mousemove` still fires on tap,
 * which would leave the button translated off-centre with no `mouseleave` to
 * put it back. So the effect only binds where a fine pointer actually exists.
 */

import { forwardRef, useEffect, useRef } from "react";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ElementType } from "react";
import { gsap } from "gsap";

export type MagneticButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  AnchorHTMLAttributes<HTMLAnchorElement> & {
    as?: ElementType;
    /** How far the element chases the cursor. 0 disables the pull. */
    strength?: number;
    /**
     * Present so `as={Link}` typechecks. A fully polymorphic generic would infer
     * this from the element, but it costs a lot of type machinery for one prop
     * on one page — this is the honest, small version.
     */
    to?: string;
  };

const MagneticButton = forwardRef<HTMLElement, MagneticButtonProps>(
  ({ className, children, as: Component = "button", strength = 0.35, ...props }, forwardedRef) => {
    const localRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
      const element = localRef.current;
      if (!element) return;

      const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
      const stillMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!finePointer || stillMotion || strength === 0) return;

      const ctx = gsap.context(() => {
        const onMove = (e: MouseEvent) => {
          const r = element.getBoundingClientRect();
          const x = e.clientX - r.left - r.width / 2;
          const y = e.clientY - r.top - r.height / 2;
          gsap.to(element, {
            x: x * strength,
            y: y * strength,
            rotationX: -y * 0.12,
            rotationY: x * 0.12,
            scale: 1.04,
            ease: "power2.out",
            duration: 0.4,
          });
        };

        const onLeave = () => {
          gsap.to(element, {
            x: 0,
            y: 0,
            rotationX: 0,
            rotationY: 0,
            scale: 1,
            ease: "elastic.out(1, 0.4)",
            duration: 1.1,
          });
        };

        element.addEventListener("mousemove", onMove);
        element.addEventListener("mouseleave", onLeave);
        return () => {
          element.removeEventListener("mousemove", onMove);
          element.removeEventListener("mouseleave", onLeave);
        };
      }, element);

      return () => ctx.revert();
    }, [strength]);

    return (
      <Component
        ref={(node: HTMLElement | null) => {
          localRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node as HTMLElement);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        className={className}
        {...props}
      >
        {children}
      </Component>
    );
  },
);

MagneticButton.displayName = "MagneticButton";

export default MagneticButton;
