import { describe, expect, it } from 'vitest'
import { BJ } from '../../src/countries/BJ.js'
import { maskPhoneNumber, parsePhoneNumber } from '../../src/domain/phone.js'

describe('parsePhoneNumber au Bénin', () => {
  it.each([
    '0197000045',
    '01 97 00 00 45',
    '01.97.00.00.45',
    '2290197000045',
    '+2290197000045',
    '+229 01 97 00 00 45',
    '002290197000045',
    '97000045',
    '22997000045',
    '+22997000045',
  ])('normalise %s', (raw) => {
    expect(parsePhoneNumber(raw, BJ).e164).toBe('+2290197000045')
  })

  it.each(['', 'abc', '0297000045', '019700004', '+330197000045', '+2290297000045', '01970000450'])(
    'refuse « %s »',
    (raw) => {
      expect(() => parsePhoneNumber(raw, BJ)).toThrowError(
        expect.objectContaining({ code: 'INVALID_PHONE' }),
      )
    },
  )
})

describe('maskPhoneNumber', () => {
  it('ne laisse voir que le début et la fin', () => {
    const phone = parsePhoneNumber('0197000045', BJ)
    expect(maskPhoneNumber(phone, BJ)).toBe('+229 01 97 •• •• 45')
  })
})
