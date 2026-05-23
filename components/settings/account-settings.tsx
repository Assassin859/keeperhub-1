import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AccountSettingsProps = {
  accountName: string;
  accountEmail: string;
  /**
   * Set when the user has TOTP enrolled AND the email field has
   * diverged from its loaded value. Triggers the inline 6-digit
   * code prompt — the server requires a fresh TOTP code on email
   * changes for enrolled users to defend against account-takeover
   * via the password-reset path.
   */
  showMfaCode?: boolean;
  totpCode?: string;
  onNameChange: (name: string) => void;
  onEmailChange: (email: string) => void;
  onTotpChange?: (code: string) => void;
};

export function AccountSettings({
  accountName,
  accountEmail,
  showMfaCode,
  totpCode,
  onNameChange,
  onEmailChange,
  onTotpChange,
}: AccountSettingsProps) {
  return (
    <Card className="border-0 py-0 shadow-none">
      <CardContent className="space-y-4 p-0">
        <div className="space-y-2">
          <Label className="ml-1" htmlFor="accountName">
            Name
          </Label>
          <Input
            id="accountName"
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Your name"
            value={accountName}
          />
        </div>

        <div className="space-y-2">
          <Label className="ml-1" htmlFor="accountEmail">
            Email
          </Label>
          <Input
            id="accountEmail"
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder="your.email@example.com"
            type="email"
            value={accountEmail}
          />
        </div>

        {showMfaCode && (
          <div className="space-y-2">
            <Label className="ml-1" htmlFor="accountTotp">
              Authenticator code (required to change email)
            </Label>
            <Input
              autoComplete="one-time-code"
              className="font-mono text-center text-lg tracking-[0.3em]"
              id="accountTotp"
              inputMode="numeric"
              maxLength={6}
              onChange={(e) =>
                onTotpChange?.(e.target.value.replace(/\D/g, ""))
              }
              placeholder="000000"
              value={totpCode ?? ""}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
