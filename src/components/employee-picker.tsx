"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { searchEmployees } from "@/lib/employee-search";
import type { Staff } from "@/lib/timesheets";

function employeeLabel(person: Staff) {
  return person.display_name + (person.active ? "" : " (archived)");
}

export function EmployeePicker({
  label,
  staff,
  value,
  onSelect,
  allowAll = false,
  disabled = false,
  showLabel = false,
}: {
  label: string;
  staff: Staff[];
  value: string;
  onSelect: (id: string) => void;
  allowAll?: boolean;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const activeOption = useRef<HTMLLIElement>(null);
  const person = staff.find((employee) => employee.id === value);
  const selectedLabel = person
    ? employeeLabel(person)
    : allowAll
      ? "All employees"
      : "";
  const options = searchEmployees(staff, query ?? "").map((employee) => ({
    id: employee.id,
    label: employeeLabel(employee),
  }));
  if (allowAll && !query?.trim()) {
    options.unshift({ id: "", label: "All employees" });
  }

  useEffect(() => {
    activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, query]);

  function dismiss() {
    setOpen(false);
    setQuery(null);
    setActiveIndex(-1);
  }

  function choose(employeeId: string) {
    onSelect(employeeId);
    dismiss();
  }

  return (
    <div className="employee-picker">
      {showLabel && <label htmlFor={`${id}-input`}>{label}</label>}
      <div className="employee-picker-field">
        <input
          id={`${id}-input`}
          className="employee-search"
          role="combobox"
          aria-label={showLabel ? undefined : label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-activedescendant={
            open && options[activeIndex] ? `${id}-${activeIndex}` : undefined
          }
          autoComplete="off"
          placeholder="Search employees"
          required={!allowAll}
          disabled={disabled}
          value={query ?? selectedLabel}
          onFocus={(event) => {
            setOpen(true);
            event.currentTarget.select();
          }}
          onClick={(event) => {
            if (!open) {
              setOpen(true);
              event.currentTarget.select();
            }
          }}
          onBlur={dismiss}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(event.target.value.trim() ? 0 : -1);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            switch (event.key) {
              case "ArrowDown":
              case "ArrowUp":
                event.preventDefault();
                setOpen(true);
                setActiveIndex((index) =>
                  event.key === "ArrowDown"
                    ? Math.min(index + 1, options.length - 1)
                    : index < 0
                      ? options.length - 1
                      : Math.max(index - 1, 0),
                );
                break;
              case "Enter":
                if (!open) break;
                event.preventDefault();
                if (options[activeIndex]) choose(options[activeIndex].id);
                break;
              case "Escape":
                if (!open) break;
                event.preventDefault();
                event.stopPropagation();
                dismiss();
                break;
            }
          }}
        />
        <ChevronDown size={16} aria-hidden="true" />
      </div>
      {open && (
        <div className="employee-picker-menu">
          <ul id={id} role="listbox" aria-label={label}>
            {options.map((option, index) => (
              <li
                key={option.id}
                id={`${id}-${index}`}
                ref={index === activeIndex ? activeOption : undefined}
                role="option"
                aria-selected={option.id === value}
                data-highlighted={index === activeIndex || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option.id)}
              >
                {option.label}
                {option.id === value && <Check size={16} aria-hidden="true" />}
              </li>
            ))}
          </ul>
          {!options.length && (
            <p role="status">
              {staff.length
                ? "No employees match your search."
                : "No employees yet."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
