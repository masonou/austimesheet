import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Button({ className, ...props }: ComponentProps<"button">) {
  return (
    <button data-slot="button" className={cn("button", className)} {...props} />
  );
}
