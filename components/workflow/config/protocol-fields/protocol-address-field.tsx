"use client";

import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { SaveAddressBookmark } from "@/components/address-book/save-address-bookmark";
import { parseAddressBookSelection } from "@/lib/address-book-selection";
import { toChecksumAddress } from "@/lib/address-utils";
import { validateAddress } from "@/lib/solidity-type-fields";
import { useMemo } from "react";

type ProtocolAddressFieldProps = {
  fieldKey: string;
  value: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  placeholder?: string;
  config?: Record<string, unknown>;
  nodeId?: string;
};

export function ProtocolAddressField({
  fieldKey,
  value,
  onChange,
  disabled,
  placeholder,
  config,
  nodeId,
}: ProtocolAddressFieldProps): React.ReactNode {
  const displayValue = toChecksumAddress(value ?? "");

  const validation = useMemo(() => {
    if (!value || value === "") return null;
    const result = validateAddress(value);
    return result.valid ? null : result.message;
  }, [value]);

  const selectionMap = config ? parseAddressBookSelection(config) : {};
  const selectedBookmarkId = selectionMap[fieldKey];

  return (
    <SaveAddressBookmark
      fieldKey={fieldKey}
      nodeId={nodeId}
      selectedBookmarkId={selectedBookmarkId}
    >
      <div className="relative">
        <TemplateBadgeInput
          disabled={disabled}
          id={fieldKey}
          onChange={onChange}
          placeholder={placeholder ?? "0x..."}
          value={displayValue}
        />
        {validation && (
          <p className="mt-1 text-xs text-destructive">{validation}</p>
        )}
      </div>
    </SaveAddressBookmark>
  );
}
