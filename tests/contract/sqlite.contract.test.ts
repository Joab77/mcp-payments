import { SqlitePaymentRepository } from '../../src/store/sqlite/SqlitePaymentRepository.js'
import { runRepositoryContract } from './repositoryContract.js'

runRepositoryContract('sqlite', () => new SqlitePaymentRepository(':memory:'))
