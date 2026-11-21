"use client";
import { Input } from "./ui/input";

export function PinChoice({
  manual,
  onChange,
}: {
  manual: boolean;
  onChange: (manual: boolean) => void;
}) {
  return (
    <>
      <label>
        New PIN
        <select
          value={manual ? "manual" : "random"}
          onChange={(e) => onChange(e.target.value === "manual")}
        >
          <option value="random">Generate randomly</option>
          <option value="manual">Choose six digits</option>
        </select>
      </label>
      {manual && (
        <Input
          aria-label="New six-digit PIN"
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{6}"
          maxLength={6}
          required
        />
      )}
    </>
  );
}
