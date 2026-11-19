import Link from "next/link";
import Image from "next/image";

export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="Shiftbook home">
      <Image src="/shiftbook.svg" alt="" width={36} height={36} priority />
      Shiftbook
    </Link>
  );
}
