"use client";

import type { KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

type ScanInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  error?: string;
};

export function ScanInput({
  value,
  onChange,
  onSubmit,
  disabled,
  error,
}: ScanInputProps): React.ReactElement {
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Label className="sr-only" htmlFor="scan-address">
        Wallet address
      </Label>
      <div className="flex gap-2">
        <Input
          aria-describedby="scan-error"
          aria-invalid={!!error || undefined}
          aria-label="EVM wallet address"
          autoComplete="off"
          id="scan-address"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="0x... or paste address"
          spellCheck={false}
          type="text"
          value={value}
        />
        <Button disabled={disabled} onClick={onSubmit} type="button">
          {disabled ? (
            <>
              <Spinner className="mr-2 size-4" />
              Scanning...
            </>
          ) : (
            "Scan"
          )}
        </Button>
      </div>
      {error ? (
        <p
          className="text-sm text-[var(--color-text-error)]"
          id="scan-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
