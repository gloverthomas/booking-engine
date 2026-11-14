"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

export interface IntakeQuestionDraft {
  id: string;
  label: string;
  required: boolean;
}

interface IntakeQuestionsEditorProps {
  questions: IntakeQuestionDraft[];
  onChange: (next: IntakeQuestionDraft[]) => void;
  /** Field errors keyed like "intakeQuestions.0.label". */
  errors: Record<string, string>;
}

const MAX_QUESTIONS = 10;

/** Ids only need to be unique within a service and stable once saved: answers are keyed by them. */
function newQuestionId(): string {
  return `q${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/** Edits the extra questions a client answers when they pick this service. */
export function IntakeQuestionsEditor({ questions, onChange, errors }: IntakeQuestionsEditorProps) {
  function update(index: number, patch: Partial<IntakeQuestionDraft>) {
    onChange(questions.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }

  return (
    <div className="flex flex-col gap-4">
      {questions.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No questions. Add one to ask clients something before they book, such as allergies or hair
          history.
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {questions.map((question, index) => (
            <li
              key={question.id}
              className="flex flex-col gap-2 rounded-card border border-line bg-paper p-4"
            >
              <Input
                label={`Question ${index + 1}`}
                value={question.label}
                onChange={(e) => update(index, { label: e.target.value })}
                error={
                  errors[`intakeQuestions.${index}.label`] ?? errors[`intakeQuestions.${index}.id`]
                }
                placeholder="e.g. Any allergies we should know about?"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Checkbox
                  label="Required"
                  checked={question.required}
                  onChange={(e) => update(index, { required: e.target.checked })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onChange(questions.filter((_, i) => i !== index))}
                  aria-label={`Remove question ${index + 1}`}
                >
                  <Trash2 aria-hidden className="size-4" />
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {questions.length < MAX_QUESTIONS ? (
        <div>
          <Button
            variant="secondary"
            onClick={() =>
              onChange([...questions, { id: newQuestionId(), label: "", required: false }])
            }
          >
            <Plus aria-hidden className="size-4" />
            Add question
          </Button>
        </div>
      ) : null}
    </div>
  );
}
