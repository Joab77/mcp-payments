import { BJ } from '../../src/countries/BJ.js'
import { parsePhoneNumber } from '../../src/domain/phone.js'
import { FakeProvider } from '../../src/providers/fake/FakeProvider.js'
import { runProviderContract } from './providerContract.js'

runProviderContract('fake', {
  makeProvider: () => new FakeProvider('XOF'),
  currency: 'XOF',
  numbers: {
    successful: parsePhoneNumber('0197000045', BJ),
    failed: parsePhoneNumber('0197000040', BJ),
    pending: parsePhoneNumber('0197000043', BJ),
  },
})
