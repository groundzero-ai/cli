---
# GroundZero formula
formula:
  name: scalable-nestjs
---

# Repository Guidelines for NestJS Applications

## Core Principles

### 1. Repository Pattern Fundamentals
- **Single Responsibility**: Each repository handles one entity/table
- **Dependency Injection**: Use `@Injectable()` and dependency injection decorators
- **Type Safety**: Leverage TypeScript with proper database entity types
- **Error Handling**: Use global exception filters, avoid throwing in repositories

### 2. Method Organization
Order methods by CRUD operations:
1. Create operations
2. Read operations (findOne, findMany, exists)
3. Update operations
4. Delete operations
5. Bulk operations

## Repository Structure

### Basic Repository Template
```typescript
@Injectable()
export class EntityRepository {
  constructor(
    private readonly entityDataSource: EntityDataSource,
  ) {}

  // Create operations
  async create(data: Partial<Entity>): Promise<Entity> {
    const entity = await this.entityDataSource.create(data);
    return entity;
  }

  // Read operations
  async findById(id: string): Promise<Entity | null> {
    return this.entityDataSource.findById(id);
  }

  async findAll(): Promise<Entity[]> {
    return this.entityDataSource.findAll();
  }

  // Update operations
  async update(id: string, data: Partial<Entity>): Promise<Entity | null> {
    return this.entityDataSource.update(id, data);
  }

  // Delete operations
  async delete(id: string): Promise<Entity | null> {
    return this.entityDataSource.delete(id);
  }
}
```

### Advanced Repository Features

#### Parameter Objects for Complex Queries
```typescript
async findByFilters({
  filters,
  options,
}: {
  filters: EntityFilters,
  options: EntityQueryOptions,
}): Promise<Entity[]> {
  // Implementation using database-specific query building
}
```

#### Existence Checks
```typescript
async existsByField(field: string, excludeId?: string): Promise<boolean> {
  const query = this.buildExistsQuery(field, excludeId);
  const count = await this.entityDataSource.count(query);
  return count > 0;
}
```

## Best Practices

### 1. Type Definitions
```typescript
export interface EntityFilters {
  status?: EntityStatus;
  dateRange?: DateRange;
  searchTerm?: string;
}

export interface EntityQueryOptions {
  include?: string[]; // Relationships to include
  select?: string[]; // Fields to select
  orderBy?: Record<string, 'ASC' | 'DESC'>;
}
```

### 2. Data Access Abstraction
```typescript
// Generic data source interface
export interface EntityDataSource {
  create(data: Partial<Entity>): Promise<Entity>;
  findById(id: string): Promise<Entity | null>;
  findByIds(ids: string[]): Promise<Entity[]>;
  findAll(): Promise<Entity[]>;
  update(id: string, data: Partial<Entity>): Promise<Entity | null>;
  delete(id: string): Promise<Entity | null>;
  count(query?: any): Promise<number>;
}
```

### 3. Relationship Loading Strategy
```typescript
async findWithRelations(id: string, relations: string[] = []): Promise<Entity | null> {
  const query = this.entityDataSource.findById(id);

  if (relations.length) {
    // Load relationships based on your ORM
    for (const relation of relations) {
      query = this.loadRelation(query, relation);
    }
  }

  return query;
}
```

### 4. Bulk Operations
```typescript
async deleteMany(ids: string[]): Promise<void> {
  await this.entityDataSource.deleteMany(ids);
}

async updateMany(filter: any, update: any): Promise<void> {
  await this.entityDataSource.updateMany(filter, update);
}
```

### 5. Documentation
```typescript
/**
 * Finds entities by filters with optional query options
 * @param params Query parameters including filters and options
 * @returns Promise resolving to array of entity results
 */
async findByFilters(params: FindByFiltersParams): Promise<Entity[]> {
  // Implementation using database-specific query building
}
```

## Performance Considerations

1. **Indexing**: Ensure proper database indexes for frequently queried fields
2. **Field Selection**: Use field selection to limit returned data when not needed
3. **Pagination**: Implement efficient pagination strategies for large datasets
4. **Query Optimization**: Use database-specific query optimization techniques
5. **Caching**: Consider caching strategies for frequently accessed data

## Error Handling

- Use consistent error types across repositories
- Leverage database built-in validation and constraints
- Handle connection errors gracefully
- Log errors with appropriate context
- Avoid exposing sensitive information in errors

## Security Considerations

- Validate all input parameters
- Use parameterized queries (avoid string concatenation)
- Implement proper access control at service layer
- Sanitize search inputs
- Limit query result sizes
- Use database connection pooling appropriately
