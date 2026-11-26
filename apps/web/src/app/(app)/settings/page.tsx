import { EFFORT_OPTIONS, MODEL_OPTIONS } from "@phil/core";
import { SettingsForm } from "./SettingsForm";

export default function SettingsPage() {
  return (
    <div className="pane-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
        <div>
          <h1 className="text-xl font-semibold">Assistant settings</h1>
          <p className="text-sm text-slate-500">How Claude replies to WhatsApp messages. Changes apply to the next reply.</p>
        </div>
        <SettingsForm models={MODEL_OPTIONS.map((m) => ({ id: m.id, label: m.label }))} efforts={[...EFFORT_OPTIONS]} />
      </div>
    </div>
  );
}
