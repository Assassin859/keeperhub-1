"use client";

import { Check, Copy, Download, EyeOff, KeyRound } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  codes: string[] | null;
  onGenerate?: () => Promise<void> | void;
  generateLabel?: string;
  onConfirmed: () => void;
};

const CONFIRM_PROMPT_COUNT = 2;

function pickConfirmationIndexes(total: number): number[] {
  const indexes = Array.from({ length: total }, (_, i) => i);
  const picked: number[] = [];
  while (picked.length < CONFIRM_PROMPT_COUNT && indexes.length > 0) {
    const idx = Math.floor(Math.random() * indexes.length);
    picked.push(indexes[idx]);
    indexes.splice(idx, 1);
  }
  return picked.sort((a, b) => a - b);
}

function downloadAsText(codes: string[]): void {
  const content = [
    "KeeperHub two-factor authentication backup codes",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Each code can be used once if you lose access to your authenticator.",
    "Keep this file secret.",
    "",
    ...codes.map(
      (code, idx) => `${(idx + 1).toString().padStart(2, " ")}. ${code}`
    ),
    "",
  ].join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "keeperhub-backup-codes.txt";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Three-phase backup-codes UX:
 *
 *   1. PRE-GENERATE — codes are not on the wire yet. Shows a single
 *      "Generate" call-to-action. Only rendered if `onGenerate` is
 *      provided (the regenerate-later flow); the enrollment flow
 *      receives pre-fetched codes and skips this phase.
 *
 *   2. EXPORT — codes are visible. Two required action chips (Copy +
 *      Download .txt) must both be clicked before the confirm step is
 *      unlocked. The chips render as primary call-to-action buttons so
 *      it's visually clear they're required, not optional. Once both
 *      fire, the codes themselves are hidden from the UI (we keep them
 *      in component state only for the retype check that follows).
 *
 *   3. RETYPE — confirmation. User must type two codes at random
 *      positions, from their own saved copy. Disabled until both
 *      Copy + Download have fired.
 *
 * The container dialog refuses to close while this panel is showing
 * the codes and hasn't yet called onConfirmed.
 */
export function TotpBackupCodesPanel({
  codes,
  onGenerate,
  generateLabel,
  onConfirmed,
}: Props): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [inputs, setInputs] = useState<Record<number, string>>({});
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const promptIndexes = useMemo<number[]>(
    () => (codes ? pickConfirmationIndexes(codes.length) : []),
    [codes]
  );

  if (codes === null) {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertDescription>
            Backup codes are hidden until you choose to generate them. Once
            shown they cannot be re-viewed — you'll need to save them
            immediately.
          </AlertDescription>
        </Alert>
        <div className="flex flex-col items-center gap-3 rounded-md border bg-muted/30 p-6">
          <KeyRound
            aria-hidden="true"
            className="size-8 text-muted-foreground"
          />
          <p className="text-center font-mono text-muted-foreground text-sm">
            ●●●●●-●●●●● ●●●●●-●●●●●
          </p>
          <Button
            disabled={generating || !onGenerate}
            onClick={async () => {
              if (!onGenerate) {
                return;
              }
              setGenerating(true);
              try {
                await onGenerate();
              } finally {
                setGenerating(false);
              }
            }}
          >
            {generating ? "Generating..." : (generateLabel ?? "Generate codes")}
          </Button>
        </div>
      </div>
    );
  }

  const canConfirm = copied && downloaded;
  const codesHidden = canConfirm;

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      toast.success("Backup codes copied to clipboard");
    } catch {
      toast.error("Copy failed — use the download button instead");
    }
  };

  const handleDownload = (): void => {
    try {
      downloadAsText(codes);
      setDownloaded(true);
      toast.success("Backup codes downloaded");
    } catch {
      toast.error("Download failed");
    }
  };

  const handleConfirm = (): void => {
    if (!canConfirm) {
      return;
    }
    setConfirming(true);
    for (const idx of promptIndexes) {
      const expected = codes[idx];
      const typed = (inputs[idx] ?? "").trim();
      if (typed !== expected) {
        toast.error(
          `Code at position #${idx + 1} does not match. Open your saved copy.`
        );
        setConfirming(false);
        return;
      }
    }
    onConfirmed();
  };

  return (
    <div className="space-y-4">
      <Alert>
        <AlertDescription>
          Save these codes before continuing. They are shown only once and
          this dialog cannot be closed until you confirm you have them.
        </AlertDescription>
      </Alert>

      <div className="space-y-2">
        <Label>Your backup codes</Label>
        {codesHidden ? (
          <div className="flex items-center gap-3 rounded-md border bg-muted/30 p-3 text-muted-foreground text-xs">
            <EyeOff aria-hidden="true" className="size-4" />
            <span>
              Hidden. Use your copied list or downloaded file to confirm
              below.
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 font-mono text-xs">
            {codes.map((code, idx) => (
              <div className="flex gap-2" key={code}>
                <span className="text-muted-foreground">
                  {(idx + 1).toString().padStart(2, " ")}.
                </span>
                <span>{code}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-sm">
          <span className="font-medium">Required:</span>{" "}
          <span className="text-muted-foreground">
            both actions before you can confirm
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            className="w-full"
            onClick={handleCopy}
            variant={copied ? "outline" : "default"}
          >
            {copied ? (
              <Check aria-hidden="true" className="mr-2 size-4" />
            ) : (
              <Copy aria-hidden="true" className="mr-2 size-4" />
            )}
            {copied ? "Copied" : "Copy all"}
          </Button>
          <Button
            className="w-full"
            onClick={handleDownload}
            variant={downloaded ? "outline" : "default"}
          >
            {downloaded ? (
              <Check aria-hidden="true" className="mr-2 size-4" />
            ) : (
              <Download aria-hidden="true" className="mr-2 size-4" />
            )}
            {downloaded ? "Downloaded" : "Download .txt"}
          </Button>
        </div>
      </div>

      <div className="space-y-3 border-t pt-4">
        <div className="space-y-1">
          <h4 className="font-medium text-sm">Confirm you saved the codes</h4>
          <p className="text-muted-foreground text-xs">
            {canConfirm
              ? `Type the codes at positions #${promptIndexes[0] + 1} and #${promptIndexes[1] + 1} from your saved copy, in order.`
              : "Copy and download the codes above first."}
          </p>
        </div>
        {promptIndexes.map((idx, position) => (
          <div className="space-y-1" key={idx}>
            <Label htmlFor={`backup-confirm-${idx}`}>
              {position + 1}. Code at position #{idx + 1}
            </Label>
            <Input
              autoComplete="off"
              className="font-mono"
              disabled={!canConfirm}
              id={`backup-confirm-${idx}`}
              maxLength={11}
              onChange={(event) =>
                setInputs((prev) => ({ ...prev, [idx]: event.target.value }))
              }
              placeholder={canConfirm ? "xxxxx-xxxxx" : "Copy and download first"}
              value={inputs[idx] ?? ""}
            />
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <Button
          disabled={
            confirming ||
            !canConfirm ||
            promptIndexes.some((i) => (inputs[i] ?? "").trim().length === 0)
          }
          onClick={handleConfirm}
        >
          Confirm and finish
        </Button>
      </div>
    </div>
  );
}
