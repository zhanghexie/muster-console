import React from 'react';
import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {AttachmentPolicyFields} from '../../src/renderer/src/components/settings/AttachmentPolicyFields';
test('video transport uses the shared popup and preserves other policy fields',async()=>{
 const onChange=vi.fn(),user=userEvent.setup();
 const view=render(<AttachmentPolicyFields value={{nativeAudio:true}} onChange={onChange}/>);
 expect(view.container.querySelector('select')).toBeNull();
 await user.click(screen.getByRole('button',{name:'Completions 视频传输'}));
 expect(screen.getByRole('listbox')).toBeTruthy();
 await user.click(screen.getByRole('option',{name:'支持内联 Data URL'}));
 expect(onChange).toHaveBeenCalledWith({nativeAudio:true,videoTransport:'data-url'});
});
