/*
Copyright 2024 New Vector Ltd.
Copyright 2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { privateShouldBeEncrypted } from "../../../src/utils/rooms";
import { getMockClientWithEventEmitter } from "../../test-utils";

describe("privateShouldBeEncrypted()", () => {
    const mockClient = getMockClientWithEventEmitter({
        getClientWellKnown: jest.fn(),
    });

    beforeEach(() => {
        mockClient.getClientWellKnown.mockReturnValue(undefined);
    });

    it("should return false irrespective of config", () => {
        expect(privateShouldBeEncrypted(mockClient)).toEqual(false);
    });

    it("should return false even when e2ee well known default is true", () => {
        mockClient.getClientWellKnown.mockReturnValue({
            "io.element.e2ee": {
                default: true,
            },
        });
        expect(privateShouldBeEncrypted(mockClient)).toEqual(false);
    });
});
