"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export function RecoveryEmailCard({
  email,
  isAdmin,
  onUpdated,
}: {
  email: string;
  isAdmin: boolean;
  onUpdated: () => void;
}): React.ReactElement {
  const [isEditing, setIsEditing] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [updating, setUpdating] = useState(false);

  const startEditing = (): void => {
    setNewEmail(email);
    setIsEditing(true);
  };

  const cancelEditing = (): void => {
    setIsEditing(false);
    setNewEmail("");
  };

  const handleSave = async (): Promise<void> => {
    if (!newEmail) {
      toast.error("Email is required");
      return;
    }
    setUpdating(true);
    try {
      const response = await fetch("/api/user/wallet", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to update email");
      }
      toast.success("Wallet email updated successfully!");
      setIsEditing(false);
      setNewEmail("");
      onUpdated();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update email"
      );
    } finally {
      setUpdating(false);
    }
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-sm">Recovery email</span>
        {!isEditing && isAdmin && (
          <Button
            className="h-6 px-2 text-xs"
            onClick={startEditing}
            size="sm"
            variant="ghost"
          >
            Edit
          </Button>
        )}
      </div>
      {isEditing ? (
        <div className="space-y-2">
          <Input
            className="text-sm"
            disabled={updating}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="newemail@example.com"
            type="email"
            value={newEmail}
          />
          <div className="flex justify-end gap-2">
            <Button
              disabled={updating}
              onClick={cancelEditing}
              size="sm"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={updating || !newEmail || newEmail === email}
              onClick={handleSave}
              size="sm"
            >
              {updating ? (
                <>
                  <Spinner className="mr-2 h-3 w-3" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-sm">{email}</p>
          <p className="text-muted-foreground text-xs">
            Used for verification when exporting the private key.
          </p>
        </div>
      )}
    </section>
  );
}
