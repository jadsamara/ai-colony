export type CollaborationClass = "consultation" | "specialist" | "joint";
export type CollaborationEntryKind = "request_context" | "answer" | "contribution" | "shared_decision";

export function promotionAllowed(input: {
  classification: CollaborationClass;
  kind: CollaborationEntryKind;
  relevantToRecipientDomain: boolean;
  provenance: "model_generated" | "system_observed" | "user_provided" | "externally_verified";
  validated: boolean;
  expired: boolean;
  forgotten: boolean;
  requesterPrivate: boolean;
  recipientAuthorized: boolean;
}): { allowed: boolean; reason: string } {
  if (!input.recipientAuthorized) {
    return { allowed: false, reason: "The recipient is not authorized for this collaboration" };
  }
  if (input.expired || input.forgotten) {
    return { allowed: false, reason: "Expired or forgotten content cannot be promoted" };
  }
  if (input.provenance === "model_generated") {
    return { allowed: false, reason: "Model-generated content cannot be promoted as verified knowledge" };
  }
  if (input.requesterPrivate || input.kind === "request_context") {
    return { allowed: false, reason: "Another department's request or private working context is not promotable" };
  }
  if (input.classification === "consultation") {
    return { allowed: false, reason: "A consultation does not create permanent recipient memory" };
  }
  if (!input.validated) {
    return { allowed: false, reason: "Promotion requires an explicit validation" };
  }
  if (!input.relevantToRecipientDomain) {
    return { allowed: false, reason: "The content is not relevant to the recipient domain or the authorized joint task" };
  }
  if (input.classification === "specialist" && input.kind !== "contribution") {
    return { allowed: false, reason: "A specialist may retain only a validated domain contribution" };
  }
  if (input.classification === "joint" && input.kind !== "contribution" && input.kind !== "shared_decision") {
    return { allowed: false, reason: "A joint task promotes only a validated shared outcome" };
  }
  return { allowed: true, reason: "Validated, relevant, and inside the authorized retention policy" };
}

export function retainedProvenance(provenance: "model_generated" | "system_observed" | "user_provided" | "externally_verified"): "system_observed" | "user_provided" {
  return provenance === "system_observed" ? "system_observed" : "user_provided";
}
