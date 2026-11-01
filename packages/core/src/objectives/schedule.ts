export interface SchedulableTask {
  id: string;
  objectiveId: string;
  departmentId: string;
  status: string;
  dependsOn: readonly string[];
  objectiveCreatedAt: string;
  createdAt: string;
}

export interface DispatchLimits {
  globalInflight: number;
  globalLimit: number;
  perObjective: number;
  perDepartment: number;
  inflightByObjective: Readonly<Record<string, number>>;
  inflightByDepartment: Readonly<Record<string, number>>;
}

export function readyTaskIds(tasks: readonly SchedulableTask[]): string[] {
  const completed = new Set(
    tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );
  const blocked = new Set(
    tasks
      .filter((task) => task.status === "failed" || task.status === "cancelled")
      .map((task) => task.id),
  );
  return tasks
    .filter((task) => task.status === "pending")
    .filter((task) => task.dependsOn.every((dependency) => completed.has(dependency)))
    .filter((task) => task.dependsOn.every((dependency) => !blocked.has(dependency)))
    .map((task) => task.id);
}

export function blockedTaskIds(tasks: readonly SchedulableTask[]): string[] {
  const blocked = new Set(
    tasks
      .filter((task) => task.status === "failed" || task.status === "cancelled")
      .map((task) => task.id),
  );
  return tasks
    .filter((task) => task.status === "pending" || task.status === "ready")
    .filter((task) => task.dependsOn.some((dependency) => blocked.has(dependency)))
    .map((task) => task.id);
}

export function chooseDispatch(tasks: readonly SchedulableTask[], limits: DispatchLimits): string[] {
  const ready = tasks
    .filter((task) => task.status === "ready")
    .slice()
    .sort((left, right) => {
      const objectiveOrder = left.objectiveCreatedAt.localeCompare(right.objectiveCreatedAt);
      return objectiveOrder === 0 ? left.createdAt.localeCompare(right.createdAt) : objectiveOrder;
    });
  const selected: string[] = [];
  const byObjective = { ...limits.inflightByObjective };
  const byDepartment = { ...limits.inflightByDepartment };
  let global = limits.globalInflight;
  const remaining = new Set(ready.map((task) => task.id));
  let progressed = true;
  while (progressed && global < limits.globalLimit && remaining.size > 0) {
    progressed = false;
    const seenObjectives = new Set<string>();
    for (const task of ready) {
      if (!remaining.has(task.id) || seenObjectives.has(task.objectiveId)) {
        continue;
      }
      seenObjectives.add(task.objectiveId);
      if ((byObjective[task.objectiveId] ?? 0) >= limits.perObjective) {
        continue;
      }
      if ((byDepartment[task.departmentId] ?? 0) >= limits.perDepartment) {
        continue;
      }
      selected.push(task.id);
      remaining.delete(task.id);
      global += 1;
      byObjective[task.objectiveId] = (byObjective[task.objectiveId] ?? 0) + 1;
      byDepartment[task.departmentId] = (byDepartment[task.departmentId] ?? 0) + 1;
      progressed = true;
      if (global >= limits.globalLimit) {
        break;
      }
    }
  }
  return selected;
}
