---
# GroundZero formula
formula:
  name: scalable-nestjs
---

# NestJS Architecture Guidelines

## Overview

This document outlines architectural best practices for building scalable, maintainable NestJS applications based on proven patterns and enterprise-grade structure.

## Core Architectural Principles

### 1. Modular Architecture
- **Domain-Driven Design**: Organize code around business domains rather than technical layers
- **Feature Modules**: Each major feature should be encapsulated in its own module
- **Separation of Concerns**: Clear boundaries between different types of logic
- **Dependency Injection**: Leverage NestJS's powerful DI system for loose coupling

### 2. Layered Architecture
- **Presentation Layer**: Controllers handle HTTP requests/responses
- **Business Logic Layer**: Services contain domain logic
- **Data Access Layer**: Repositories handle data persistence
- **Infrastructure Layer**: External integrations and cross-cutting concerns

## Project Structure

```
src/
├── main.ts                    # Application bootstrap
├── app.module.ts             # Root module
├── app.controller.ts         # Root controller (health checks, etc.)
├── core/                     # Core framework components
│   ├── config/               # Configuration management
│   ├── database/             # Database setup and configuration
│   ├── exceptions/           # Custom exception classes
│   ├── filters/              # Global exception filters
│   ├── constants/            # Application-wide constants
│   └── index.ts              # Core exports
├── modules/                  # Business domain modules
│   ├── user/                 # User domain
│   ├── auth/                 # Authentication domain
│   ├── permissions/          # Authorization domain
│   └── [domain-name]/        # Additional domains
└── shared/                   # Shared utilities and components
    ├── utils/                # Utility functions
    ├── pipes/                # Custom pipes
    ├── repositories/         # Base repository patterns
    ├── permissions/          # Shared permission logic
    └── interfaces/           # Shared interfaces
```

## Module Structure Guidelines

### Standard Module Pattern
Each business module should follow this consistent structure:

```
module-name/
├── module-name.module.ts     # Module definition
├── module-name.controller.ts # HTTP endpoint handlers
├── module-name.service.ts    # Business logic
├── module-name.repository.ts # Data access logic
├── dto/                      # Data Transfer Objects
│   ├── create-entity.dto.ts
│   ├── update-entity.dto.ts
│   └── query-entity.dto.ts
├── schemas/                  # Database schemas
│   └── entity.schema.ts
├── interfaces/               # Module-specific interfaces
└── guards/                   # Module-specific guards (if any)
```

### Complex Module Extensions
For complex domains, additional subdirectories may include:

```
module-name/
├── [standard structure above]
├── services/                 # Multiple specialized services
├── factories/                # Factory patterns for complex object creation
├── workflows/                # Business process workflows
├── processors/               # Background job processors
├── listeners/                # Event listeners
└── utils/                    # Module-specific utilities
```

## Core Module Guidelines

### 1. Configuration Module
- **Global Configuration**: Use `@nestjs/config` with global scope
- **Environment-Based**: Support multiple environments (dev, staging, prod)
- **Type Safety**: Create typed configuration service wrapper
- **Validation**: Validate configuration at startup

```typescript
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
  ],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
```

### 2. Database Module
- **Async Configuration**: Use factory pattern for dynamic configuration
- **Feature Modules**: Register schemas in individual modules
- **Connection Management**: Single database module for connection setup

### 3. Exception Handling
- **Global Filter**: Implement global exception filter
- **Custom Exceptions**: Create domain-specific exception classes
- **Error Codes**: Use standardized error codes for client integration
- **Consistent Response Format**: Maintain uniform error response structure

## Module Design Patterns

### 1. Service-Repository Pattern
- **Services**: Contain business logic and orchestration
- **Repositories**: Handle data access and persistence
- **Clear Separation**: Services call repositories, never the reverse

```typescript
@Injectable()
export class UserService {
  constructor(private readonly userRepository: UserRepository) {}
  
  async createUser(createUserDto: CreateUserDto): Promise<UserDocument> {
    // Business logic here
    return this.userRepository.create(userData);
  }
}
```

### 2. Factory Pattern
- **Complex Object Creation**: Use factories for objects requiring complex initialization
- **Dependency Management**: Factories can inject multiple dependencies
- **Configuration-Based**: Support different implementations based on configuration

### 3. Module Imports and Exports
- **Selective Exports**: Only export what other modules need
- **Clear Dependencies**: Explicit imports make dependencies visible
- **Circular Dependencies**: Use `forwardRef()` when necessary

```typescript
@Module({
  imports: [DatabaseModule, ConfigModule],
  providers: [UserService, UserRepository],
  controllers: [UserController],
  exports: [UserService, UserRepository], // Export what others need
})
export class UserModule {}
```

## Data Transfer Objects (DTOs)

### 1. Validation
- **Class-Validator**: Use decorators for input validation
- **Transform**: Enable transformation for type conversion
- **Whitelist**: Filter out unknown properties

```typescript
export class CreateUserDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;
}
```

### 2. DTO Organization
- **Input DTOs**: For request data (create, update, query)
- **Output DTOs**: For response data (when needed)
- **Reusable DTOs**: Share common validation patterns

## Schema Design

### 1. Database Schemas
- **Mongoose Integration**: Use `@nestjs/mongoose` for MongoDB
- **Type Safety**: Export typed documents
- **Transformations**: Handle sensitive data (password hiding)
- **Timestamps**: Include created/updated timestamps

```typescript
@Schema({
  timestamps: true,
  toJSON: {
    transform: (doc, ret) => {
      delete ret.password;
      delete ret.__v;
      return ret;
    },
  },
})
export class User {
  @Prop({ required: true, unique: true })
  email: string;

  @Prop()
  password?: string;
}
```

## Authentication and Authorization

### 1. Authentication Module
- **JWT Strategy**: Implement JWT-based authentication
- **Guards**: Create reusable authentication guards
- **Strategies**: Use Passport strategies for different auth methods

### 2. Permission System
- **Role-Based**: Implement role-based access control
- **Resource-Based**: Support resource-level permissions
- **Guards and Decorators**: Create declarative permission checking

```typescript
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermissions('resource:read')
@Get()
async getResource() {
  // Protected endpoint
}
```

## Shared Components

### 1. Utilities
- **Pure Functions**: Keep utilities stateless and testable
- **Domain-Agnostic**: Shared utilities should not contain business logic
- **Type Safety**: Provide proper TypeScript types

### 2. Base Classes
- **Repository Base**: Create base repository with common operations
- **Service Base**: Abstract common service patterns
- **Exception Base**: Standardize custom exception patterns

### 3. Pipes and Interceptors
- **Validation Pipes**: Custom validation for complex scenarios
- **Transform Pipes**: Data transformation before processing
- **Logging Interceptors**: Standardized request/response logging

## Application Bootstrap

### 1. Main Application Setup
- **Global Pipes**: Enable validation and transformation
- **Global Filters**: Set up exception handling
- **Versioning**: Enable API versioning
- **Middleware**: Apply global middleware

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Global configuration
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
  }));
  
  app.useGlobalFilters(new HttpExceptionFilter());
  
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });
  
  await app.listen(process.env.PORT ?? 3000);
}
```

### 2. Logging
- **Structured Logging**: Use structured logging for production
- **Log Levels**: Configure appropriate log levels per environment
- **Request Logging**: Log HTTP requests and responses

## Background Processing

### 1. Queue Module
- **Job Processing**: Implement background job processing
- **Job Handlers**: Create specific handlers for different job types
- **Monitoring**: Include job monitoring and retry mechanisms
- **Event-Driven**: Use events for loose coupling

### 2. Queue Organization
- **Job Schemas**: Define job data structures
- **Processors**: Separate classes for job processing logic
- **Registry**: Central registry for job handlers

## Error Handling Strategy

### 1. Standardized Error Codes
- **Consistent Format**: Use kebab-case error codes
- **Module Prefixes**: Prefix codes with module names
- **Error Mapping**: Map errors to HTTP status codes

```typescript
export const ErrorCodes = {
  AUTH_INVALID_CREDENTIALS: 'auth-invalid-credentials',
  USER_NOT_FOUND: 'user-not-found',
  VALIDATION_FAILED: 'validation-failed',
} as const;
```

### 2. Exception Hierarchy
- **Custom Base**: Extend NestJS HttpException
- **Domain Exceptions**: Create specific exceptions per domain
- **Error Context**: Include relevant context in exceptions

## Testing Strategy

### 1. Unit Testing
- **Service Testing**: Test business logic in isolation
- **Repository Testing**: Test data access patterns
- **Mock Dependencies**: Use mocks for external dependencies

### 2. Integration Testing
- **Module Testing**: Test complete modules
- **Database Testing**: Use test database for integration tests
- **API Testing**: End-to-end API testing

### 3. Test Organization
- **Test Structure**: Mirror source structure in test files
- **Shared Mocks**: Create reusable test utilities
- **Test Data**: Use factories for test data generation

## Configuration Management

### 1. Environment Configuration
- **Environment Files**: Separate config files per environment
- **Secret Management**: Secure handling of sensitive configuration
- **Configuration Validation**: Validate config at startup

### 2. Feature Flags
- **Runtime Configuration**: Support runtime feature toggles
- **Gradual Rollouts**: Enable gradual feature rollouts
- **A/B Testing**: Support for experimental features

## Performance Considerations

### 1. Database Optimization
- **Indexing**: Proper database indexing strategy
- **Pagination**: Implement cursor-based pagination for large datasets
- **Query Optimization**: Optimize database queries and aggregations

### 2. Caching Strategy
- **Response Caching**: Cache frequently accessed data
- **Cache Invalidation**: Strategy for cache invalidation
- **Distributed Caching**: Use Redis for multi-instance deployments

### 3. Async Processing
- **Background Jobs**: Move heavy processing to background
- **Event-Driven**: Use events for decoupled processing
- **Batch Processing**: Implement batch processing for bulk operations

## Security Best Practices

### 1. Input Validation
- **DTO Validation**: Validate all inputs using DTOs
- **Sanitization**: Sanitize user inputs
- **Rate Limiting**: Implement rate limiting for APIs

### 2. Authentication Security
- **JWT Security**: Proper JWT token handling
- **Password Security**: Secure password hashing
- **Session Management**: Secure session handling

### 3. Authorization
- **Principle of Least Privilege**: Grant minimum required permissions
- **Resource-Level Security**: Implement fine-grained permissions
- **Audit Logging**: Log security-relevant actions

## Deployment and DevOps

### 1. Build Configuration
- **TypeScript Configuration**: Optimize TypeScript compilation
- **Environment Variables**: Proper environment variable handling
- **Health Checks**: Implement health check endpoints

### 2. Monitoring
- **Application Metrics**: Monitor application performance
- **Error Tracking**: Implement error tracking and alerting
- **Logging Strategy**: Centralized logging for production

### 3. Scalability
- **Horizontal Scaling**: Design for horizontal scaling
- **Database Scaling**: Consider database scaling strategies
- **Load Balancing**: Design for load balancer compatibility

## Conclusion

This architecture provides a solid foundation for building enterprise-grade NestJS applications. The key principles are:

1. **Modularity**: Clear separation of concerns through modules
2. **Consistency**: Standardized patterns across the application
3. **Scalability**: Design decisions that support growth
4. **Maintainability**: Code organization that facilitates long-term maintenance
5. **Security**: Built-in security considerations
6. **Testability**: Architecture that supports comprehensive testing

Follow these guidelines while adapting them to your specific domain requirements and business needs.
