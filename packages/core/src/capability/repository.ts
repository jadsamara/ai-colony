import { DomainError } from "../errors/domain-error.js";
import type {
  LedgerDecision,
  LedgerEdge,
  LedgerMapping,
  LedgerMappingVersion,
  LedgerProposal,
  LedgerRetentionEvent,
  LedgerSnapshot,
  LedgerTaxonomyVersion,
  LedgerTopic,
  LedgerTopicEvent,
} from "./types.js";

export interface CapabilityRepository {
  insertTopic(row: LedgerTopic): Promise<void>;
  findTopic(id: string): Promise<LedgerTopic | null>;
  listTopics(departmentId: string): Promise<LedgerTopic[]>;
  insertTopicEvent(row: LedgerTopicEvent): Promise<void>;
  listTopicEvents(topicId: string): Promise<LedgerTopicEvent[]>;
  insertProposal(row: LedgerProposal): Promise<void>;
  findProposal(id: string): Promise<LedgerProposal | null>;
  listProposals(departmentId: string): Promise<LedgerProposal[]>;
  insertDecision(row: LedgerDecision): Promise<void>;
  findDecision(proposalId: string): Promise<LedgerDecision | null>;
  insertTaxonomyVersion(row: LedgerTaxonomyVersion): Promise<void>;
  listTaxonomyVersions(departmentId: string): Promise<LedgerTaxonomyVersion[]>;
  findTaxonomyVersion(id: string): Promise<LedgerTaxonomyVersion | null>;
  insertEdges(rows: LedgerEdge[]): Promise<void>;
  listEdges(versionId: string): Promise<LedgerEdge[]>;
  insertMappingVersion(row: LedgerMappingVersion): Promise<void>;
  listMappingVersions(departmentId: string): Promise<LedgerMappingVersion[]>;
  findMappingVersion(id: string): Promise<LedgerMappingVersion | null>;
  insertMappings(rows: LedgerMapping[]): Promise<void>;
  listMappings(mappingVersionId: string): Promise<LedgerMapping[]>;
  insertSnapshot(row: LedgerSnapshot): Promise<void>;
  findSnapshot(id: string): Promise<LedgerSnapshot | null>;
  listSnapshots(filter: { departmentId?: string; topicId?: string }): Promise<LedgerSnapshot[]>;
  insertRetention(row: LedgerRetentionEvent): Promise<void>;
  listRetention(snapshotId: string): Promise<LedgerRetentionEvent[]>;
}

export class MemoryCapabilityRepository implements CapabilityRepository {
  readonly topics = new Map<string, LedgerTopic>();
  readonly events: LedgerTopicEvent[] = [];
  readonly proposals = new Map<string, LedgerProposal>();
  readonly decisions = new Map<string, LedgerDecision>();
  readonly versions: LedgerTaxonomyVersion[] = [];
  readonly edges: LedgerEdge[] = [];
  readonly mappingVersions: LedgerMappingVersion[] = [];
  readonly mappings: LedgerMapping[] = [];
  readonly snapshots: LedgerSnapshot[] = [];
  readonly retention: LedgerRetentionEvent[] = [];

  async insertTopic(row: LedgerTopic): Promise<void> {
    this.ensureNew(this.topics.has(row.id), "Topic");
    this.topics.set(row.id, clone(row));
  }

  async findTopic(id: string): Promise<LedgerTopic | null> {
    return clone(this.topics.get(id) ?? null);
  }

  async listTopics(departmentId: string): Promise<LedgerTopic[]> {
    return [...this.topics.values()].filter((row) => row.departmentId === departmentId).map((row) => clone(row));
  }

  async insertTopicEvent(row: LedgerTopicEvent): Promise<void> {
    this.events.push(clone(row));
  }

  async listTopicEvents(topicId: string): Promise<LedgerTopicEvent[]> {
    return this.events.filter((row) => row.topicId === topicId).map((row) => clone(row));
  }

  async insertProposal(row: LedgerProposal): Promise<void> {
    this.ensureNew(this.proposals.has(row.id), "Proposal");
    this.proposals.set(row.id, clone(row));
  }

  async findProposal(id: string): Promise<LedgerProposal | null> {
    return clone(this.proposals.get(id) ?? null);
  }

  async listProposals(departmentId: string): Promise<LedgerProposal[]> {
    return [...this.proposals.values()].filter((row) => row.departmentId === departmentId).map((row) => clone(row));
  }

  async insertDecision(row: LedgerDecision): Promise<void> {
    if (this.decisions.has(row.proposalId)) {
      throw new DomainError("CONFLICT", "That proposal already has a decision", 409);
    }
    this.decisions.set(row.proposalId, clone(row));
  }

  async findDecision(proposalId: string): Promise<LedgerDecision | null> {
    return clone(this.decisions.get(proposalId) ?? null);
  }

  async insertTaxonomyVersion(row: LedgerTaxonomyVersion): Promise<void> {
    this.versions.push(clone(row));
  }

  async listTaxonomyVersions(departmentId: string): Promise<LedgerTaxonomyVersion[]> {
    return this.versions.filter((row) => row.departmentId === departmentId).map((row) => clone(row));
  }

  async findTaxonomyVersion(id: string): Promise<LedgerTaxonomyVersion | null> {
    return clone(this.versions.find((row) => row.id === id) ?? null);
  }

  async insertEdges(rows: LedgerEdge[]): Promise<void> {
    this.edges.push(...rows.map((row) => clone(row)));
  }

  async listEdges(versionId: string): Promise<LedgerEdge[]> {
    return this.edges.filter((row) => row.versionId === versionId).map((row) => clone(row));
  }

  async insertMappingVersion(row: LedgerMappingVersion): Promise<void> {
    this.mappingVersions.push(clone(row));
  }

  async listMappingVersions(departmentId: string): Promise<LedgerMappingVersion[]> {
    return this.mappingVersions.filter((row) => row.departmentId === departmentId).map((row) => clone(row));
  }

  async findMappingVersion(id: string): Promise<LedgerMappingVersion | null> {
    return clone(this.mappingVersions.find((row) => row.id === id) ?? null);
  }

  async insertMappings(rows: LedgerMapping[]): Promise<void> {
    this.mappings.push(...rows.map((row) => clone(row)));
  }

  async listMappings(mappingVersionId: string): Promise<LedgerMapping[]> {
    return this.mappings.filter((row) => row.mappingVersionId === mappingVersionId).map((row) => clone(row));
  }

  async insertSnapshot(row: LedgerSnapshot): Promise<void> {
    if (this.snapshots.some((existing) => existing.id === row.id)) {
      throw new DomainError("CONFLICT", "A capability snapshot cannot be overwritten", 409);
    }
    this.snapshots.push(clone(row));
  }

  async findSnapshot(id: string): Promise<LedgerSnapshot | null> {
    return clone(this.snapshots.find((row) => row.id === id) ?? null);
  }

  async listSnapshots(filter: { departmentId?: string; topicId?: string }): Promise<LedgerSnapshot[]> {
    return this.snapshots
      .filter((row) => (filter.departmentId ? row.departmentId === filter.departmentId : true))
      .filter((row) => (filter.topicId ? row.topicId === filter.topicId : true))
      .map((row) => clone(row));
  }

  async insertRetention(row: LedgerRetentionEvent): Promise<void> {
    this.retention.push(clone(row));
  }

  async listRetention(snapshotId: string): Promise<LedgerRetentionEvent[]> {
    return this.retention.filter((row) => row.snapshotId === snapshotId).map((row) => clone(row));
  }

  private ensureNew(exists: boolean, name: string): void {
    if (exists) {
      throw new DomainError("CONFLICT", `${name} identity already exists`, 409);
    }
  }
}

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
