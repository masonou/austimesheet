import type { Staff } from "./timesheets";

function searchText(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function searchEmployees(staff: Staff[], query: string) {
  const search = searchText(query).trim();
  if (!search) return staff;

  const words = search.split(/\s+/);
  return staff.filter(({ display_name }) => {
    const name = searchText(display_name);
    return words.every((word) => name.includes(word));
  });
}
