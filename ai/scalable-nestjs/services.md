---
# GroundZero formula
formula:
  name: scalable-nestjs
---

# NestJS Services Best Practices

## Core Principles

Services encapsulate business logic, orchestrate data operations, and provide clean APIs for controllers.

## Service Structure

### Basic Template

```typescript
@Injectable()
export class ExampleService {
  constructor(
    private readonly repository: ExampleRepository,
    private readonly otherService: OtherService,
  ) {}

  // Public methods: CRUD operations first, then business logic
  async create(dto: CreateDto): Promise<Entity> { /* validation + creation */ }
  async findAll(): Promise<Entity[]> { /* retrieval */ }
  async findOne(id: string): Promise<Entity> { /* single entity */ }
  async update(id: string, dto: UpdateDto): Promise<Entity> { /* modification */ }
  async delete(id: string): Promise<Entity> { /* removal */ }

  // Business-specific methods
  async performAction(dto: ActionDto): Promise<Result> { /* domain logic */ }

  // Private utilities
  private async validateInput(dto: any): Promise<void> { /* validation */ }
}
```

## Method Organization

### CRUD Order
1. **Create**: `create()`, `createBulk()`
2. **Read**: `findAll()`, `findOne()`, `findByCriteria()`
3. **Update**: `update()`, `updateBulk()`
4. **Delete**: `delete()`, `deleteBulk()`
5. **Business Logic**: Domain-specific operations

### Naming Conventions
```typescript
// Actions
async createUser(dto: CreateUserDto): Promise<User>
async findUsersByRole(role: string): Promise<User[]>
async updateUserProfile(id: string, dto: UpdateProfileDto): Promise<User>
async deleteUser(id: string): Promise<User>

// Boolean checks
async isUserActive(id: string): Promise<boolean>
async hasPermission(userId: string, permission: string): Promise<boolean>
async canAccessResource(userId: string, resourceId: string): Promise<boolean>
```

## Dependency Injection

### Constructor Pattern
```typescript
constructor(
  // 1. Primary repository
  private readonly primaryRepository: PrimaryRepository,
  // 2. Related repositories
  private readonly relatedRepository: RelatedRepository,
  // 3. Business services
  private readonly businessService: BusinessService,
  // 4. Infrastructure services
  private readonly logger: Logger,
  private readonly configService: ConfigService,
) {}
```

## Error Handling

### Exception Strategy
```typescript
async createResource(dto: CreateDto): Promise<Resource> {
  // Input validation
  if (!dto.name?.trim()) {
    throw new CustomHttpException(ErrorCodes.INVALID_INPUT);
  }

  // Business rule validation
  const existing = await this.repository.findByName(dto.name);
  if (existing) {
    throw new CustomHttpException(ErrorCodes.RESOURCE_EXISTS);
  }

  // Permission checks
  const hasPermission = await this.permissionService.canCreate(userId);
  if (!hasPermission) {
    throw new CustomHttpException(ErrorCodes.INSUFFICIENT_PERMISSIONS);
  }

  try {
    return await this.repository.create(dto);
  } catch (error) {
    this.logger.error(`Creation failed: ${error.message}`);
    throw new CustomHttpException(ErrorCodes.INTERNAL_ERROR);
  }
}
```

### Validation Pattern
```typescript
private async validateCreation(dto: CreateDto): Promise<void> {
  const errors: string[] = [];

  const validations = await Promise.all([
    this.repository.existsByName(dto.name),
    this.relatedService.exists(dto.relatedId),
    this.permissionService.hasCreatePermission(userId),
  ]);

  if (validations[0]) errors.push('Name already exists');
  if (!validations[1]) errors.push('Related entity not found');
  if (!validations[2]) errors.push('Insufficient permissions');

  if (errors.length > 0) {
    throw new CustomHttpException(ErrorCodes.VALIDATION_FAILED, errors.join(', '));
  }
}
```

## Business Logic Patterns

### Complex Operations
```typescript
async processWorkflow(input: WorkflowInput): Promise<WorkflowResult> {
  // 1. Validate input
  await this.validateWorkflowInput(input);

  // 2. Prepare data
  const processedData = await this.prepareWorkflowData(input);

  // 3. Execute steps
  for (const step of processedData.steps) {
    const result = await this.executeStep(step);
    if (!result.success) return { success: false, error: result.error };
  }

  // 4. Return result
  return { success: true, data: processedData };
}
```

### Transaction-like Operations
```typescript
async createWithDependencies(dto: CreateWithDepsDto): Promise<Result> {
  await this.validateDependencies(dto);

  const [mainEntity, dependencies] = await Promise.all([
    this.mainRepository.create(dto.mainData),
    this.dependencyService.createDependencies(dto.dependencyData),
  ]);

  await this.mainRepository.update(mainEntity._id, {
    dependencyIds: dependencies.map(d => d._id),
  });

  return { mainEntity, dependencies };
}
```

## Async Patterns

### Streaming
```typescript
async streamData(params: StreamParams): AsyncIterable<DataChunk> {
  await this.validateStreamParams(params);

  return {
    [Symbol.asyncIterator]: async function* () {
      let cursor = null;
      let hasMore = true;

      while (hasMore) {
        const batch = await fetchBatch(cursor, params.batchSize);
        for (const item of batch.items) yield item;

        hasMore = batch.hasMore;
        cursor = batch.nextCursor;
      }
    }
  };
}
```

### Parallel Processing
```typescript
async processBatch(items: Item[]): Promise<ProcessResult[]> {
  const concurrencyLimit = 5;
  const results: ProcessResult[] = [];

  for (let i = 0; i < items.length; i += concurrencyLimit) {
    const batch = items.slice(i, i + concurrencyLimit);
    const batchResults = await Promise.allSettled(
      batch.map(item => this.processItem(item))
    );

    for (const result of batchResults) {
      results.push(result.status === 'fulfilled'
        ? result.value
        : { success: false, error: result.reason }
      );
    }
  }

  return results;
}
```

## Documentation

### JSDoc Standards
```typescript
/**
 * Creates a new resource with validation and permission checks
 * @param dto Validated creation data
 * @param userId ID of the user creating the resource
 * @returns Created resource document
 * @throws CustomHttpException if validation fails
 */
async create(dto: CreateDto, userId: string): Promise<ResourceDocument> {
  // Implementation
}
```

## Performance Patterns

### Caching
```typescript
async findWithCache(id: string): Promise<Entity | null> {
  const cached = await this.cacheService.get(`entity:${id}`);
  if (cached) return cached;

  const entity = await this.repository.findById(id);
  if (entity) {
    await this.cacheService.set(`entity:${id}`, entity, 300);
  }

  return entity;
}
```

### Batch Operations
```typescript
async bulkUpdate(updates: BulkUpdateDto[]): Promise<BulkUpdateResult> {
  const groupedUpdates = this.groupByType(updates);
  const results = { successful: [], failed: [] };

  for (const [type, typeUpdates] of Object.entries(groupedUpdates)) {
    try {
      const typeResults = await this.processBatch(type, typeUpdates);
      results.successful.push(...typeResults);
    } catch (error) {
      results.failed.push(...typeUpdates.map(u => ({
        id: u.id, error: error.message
      })));
    }
  }

  return results;
}
```

## Service Communication

### Inter-Service Calls
```typescript
async createOrder(dto: CreateOrderDto): Promise<Order> {
  const [user, products] = await Promise.all([
    this.userService.findActiveUser(dto.userId),
    this.productService.validateProducts(dto.productIds),
  ]);

  const total = this.calculateTotal(products);
  const paymentIntent = await this.paymentService.createIntent(total);

  return this.orderRepository.create({
    userId: user._id,
    productIds: products.map(p => p._id),
    total,
    paymentIntentId: paymentIntent.id,
  });
}
```

## Key Guidelines

1. **Single Responsibility**: One clear purpose per service
2. **Constructor Injection**: Use `private readonly` for all dependencies
3. **Error Handling**: Custom exceptions with meaningful messages
4. **Async/Await**: Never return raw Promises
5. **Input Validation**: Validate before processing
6. **JSDoc Documentation**: Document all public methods
7. **CRUD Order**: Organize methods consistently
8. **Private Methods**: Extract utilities and validations
9. **Parallel Operations**: Use `Promise.all()` for independent tasks
10. **Early Returns**: Use guards and early returns for clarity
