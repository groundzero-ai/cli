---
# GroundZero formula
formula:
  name: scalable-nestjs-mongodb
---

# Mongoose Schema Guidelines for NestJS

## Core Structure

### Schema Class Definition
```typescript
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DocumentName = HydratedDocument<EntityName>;

@Schema({
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: (doc, ret) => {
      delete ret.__v;
      return ret;
    },
  },
})
export class EntityName {
  // Properties with @Prop decorators
}

export const SchemaName = SchemaFactory.createForClass(EntityName);
```

### Document Type Declaration

Use `interface` when you need to define virtual fields or population properties:

```typescript
// For schemas with virtuals/populations
export interface DocumentName extends HydratedDocument<EntityName> {
  populatedField?: RelatedEntity;  // Virtual/populated field
}

// Simple schemas without virtuals
export type SimpleDocument = HydratedDocument<EntityName>;
```

## References and Relationships

### ObjectId References
```typescript
@Prop({ type: Types.ObjectId, ref: 'RelatedEntity', required: true })
relatedEntityId: Types.ObjectId;

// Array of references
@Prop({ type: [Types.ObjectId], ref: 'RelatedEntity', default: [] })
relatedEntityIds: Types.ObjectId[];
```

### Virtual Population
```typescript
// Define virtual in schema setup
SchemaName.virtual('relatedEntities', {
  ref: 'RelatedEntity',
  localField: 'relatedEntityIds',
  foreignField: '_id',
  justOne: false,
});

// Include in toJSON
@Schema({
  toJSON: { virtuals: true }
})
```

## Subdocuments

### Subdocument Schema (Usually no _id, include if required)
```typescript
@Schema({
  _id: false,
  toJSON: {
    transform: (doc, ret) => {
      delete ret.__v;
      return ret;
    },
  },
})
export class SubEntity {
  @Prop()
  field: string;
}

// Usage in parent schema
@Prop({ type: [SubEntity], default: [] })
subEntities: SubEntity[];
```

## Enums

### Enum Definition and Usage
```typescript
export enum Status {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  PENDING = 'pending',
}

@Prop({
  type: String,
  enum: Status,
  default: Status.PENDING
})
status: Status;
```

## Best Practices

### 1. Naming Conventions
- Use PascalCase for class names
- Use camelCase for property names
- Append `Schema` to schema constants
- Append `Document` to document types

### 2. Property Design
- Use meaningful property names
- Prefer specific types over `any`
- Use optional properties with `?` for nullable fields
- Set appropriate defaults for boolean and array fields

### 3. Security
- Remove sensitive fields in `toJSON` transform
- Use `delete ret.__v` to clean output
- Avoid exposing internal IDs when possible

### 4. Performance
- Create indexes for frequently queried fields
- Use compound indexes for multi-field queries
- Consider index direction (1 for ascending, -1 for descending)

### 5. Data Integrity
- Use `required: true` for mandatory fields
- Implement `unique: true` for unique constraints
- Use enums for controlled vocabularies

### 6. Relationships
- Use ObjectId references for relationships
- Implement virtuals for automatic population
- Consider embedding vs referencing based on access patterns

### 7. Validation
- Use schema-level validation for data integrity
- Implement custom validators when needed
- Handle validation errors appropriately

### 8. Schema Organization
- One schema per file
- Group related schemas in subdirectories
- Export both class and schema factory

## Common Patterns

### Soft Delete
```typescript
@Prop({ default: false })
isDeleted: boolean;

@Prop({ type: Date })
deletedAt?: Date;
```

### Version Control
```typescript
@Prop({ default: 1 })
version: number;

@Prop({ type: Object })
changes: Record<string, any>;
```

### Audit Fields
```typescript
@Prop()
createdBy?: string;

@Prop()
updatedBy?: string;
```

## Error Handling

- Handle validation errors in service layer
- Use try-catch for database operations
- Provide meaningful error messages
- Log errors for debugging

## Testing

- Test schema validation rules
- Test virtual population
- Test indexes for query performance
- Test relationships and references

## Migration Considerations

- Plan schema changes carefully
- Use migration scripts for production
- Consider backward compatibility
- Test migrations thoroughly
